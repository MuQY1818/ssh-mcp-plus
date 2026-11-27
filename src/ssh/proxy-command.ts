import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { Profile } from '../types.js';

/** How much of the proxy's stderr is kept for the error message. */
const STDERR_TAIL_BYTES = 2_000;

/**
 * Expand the OpenSSH tokens a ProxyCommand line uses: `%h` host, `%p` port, `%r` user, `%n`
 * profile name, `%%` a literal percent. Values are substituted as they are, like OpenSSH does,
 * so a line copied from `~/.ssh/config` behaves the same here. Any other `%x` is an error:
 * passing it through would run a command the operator did not write.
 */
export function expandProxyCommand(command: string, profile: Pick<Profile, 'host' | 'port' | 'user' | 'name'>): string {
  return command.replace(/%(.)/g, (match, token: string) => {
    switch (token) {
      case 'h': return profile.host;
      case 'p': return String(profile.port);
      case 'r': return profile.user;
      case 'n': return profile.name;
      case '%': return '%';
      default:
        throw new Error(`proxyCommand: unsupported token "${match}" (supported: %h %p %r %n %%)`);
    }
  });
}

/** argv for running one command line through the platform shell. */
function shellArgv(line: string): [string, string[]] {
  if (process.platform === 'win32') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line]];
  return ['/bin/sh', ['-c', line]];
}

export interface ProxySocket {
  sock: Duplex;
  child: ChildProcess;
}

/**
 * Start a profile's `proxyCommand` and expose its stdin/stdout as the socket ssh2 speaks over,
 * the way OpenSSH's ProxyCommand does (`nc -X connect -x proxy:port %h %p`, `ssh -W %h:%p jump`,
 * `cloudflared access ssh --hostname %h`, ...).
 *
 * Lifetime is tied both ways: when the socket closes the process is killed, and when the process
 * exits the socket is destroyed, with the tail of its stderr in the error when it failed. Without
 * the second half a proxy that dies (refused CONNECT, wrong port) leaves ssh2 waiting for its
 * full readyTimeout and reporting a bare timeout.
 */
export function spawnProxyCommand(profile: Pick<Profile, 'host' | 'port' | 'user' | 'name' | 'proxyCommand'>): Promise<ProxySocket> {
  if (!profile.proxyCommand) return Promise.reject(new Error(`profile "${profile.name}" has no proxyCommand`));
  let line: string;
  try {
    line = expandProxyCommand(profile.proxyCommand, profile);
  } catch (err) {
    return Promise.reject(err);
  }
  const [file, args] = shellArgv(line);
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  // A write after the process exited raises EPIPE on stdin; the socket reports the failure.
  child.stdin!.on('error', () => {});

  const out = child.stdout!;
  const inp = child.stdin!;
  const sock = new Duplex({
    read() {
      out.resume();
    },
    write(chunk, encoding, callback) {
      inp.write(chunk, encoding, callback);
    },
    final(callback) {
      inp.end();
      callback();
    },
    destroy(err, callback) {
      out.destroy();
      inp.destroy();
      callback(err);
    },
  });
  out.on('data', (chunk: Buffer) => {
    if (!sock.push(chunk)) out.pause();
  });
  // EOF is held until the process has exited: ssh2 reacts to an end of stream before the
  // handshake with a bare "Connection lost before handshake", and the reason (nc's "connection
  // refused", a 403 from the HTTP proxy) only arrives with the exit status a moment later.
  let outEnded = false;
  let exitError: Error | null | undefined;
  const finish = () => {
    if (!outEnded || exitError === undefined || sock.destroyed) return;
    if (exitError) sock.destroy(exitError);
    else sock.push(null);
  };
  out.on('end', () => {
    outEnded = true;
    finish();
  });
  let exited = false;
  sock.on('close', () => {
    if (!exited) child.kill();
  });

  return new Promise<ProxySocket>((resolve, reject) => {
    let started = false;
    child.once('spawn', () => {
      started = true;
      resolve({ sock, child });
    });
    child.once('error', (err) => {
      if (!started) reject(new Error(`proxyCommand for "${profile.name}" failed to start: ${err.message}`));
      else sock.destroy(err);
    });
    // 'close', not 'exit': it fires once stdio is drained, so the stderr tail is complete.
    child.once('close', (code, signal) => {
      exited = true;
      if (sock.destroyed) return;
      const tail = stderr.trim();
      if (code === 0 || signal === 'SIGTERM') {
        exitError = null;
      } else {
        const why = signal ? `was killed by ${signal}` : `exited with code ${code}`;
        exitError = new Error(`proxyCommand for "${profile.name}" ${why}${tail ? `: ${tail}` : ''}`);
      }
      // stdout may still be open if the process left a child holding it; do not wait for it then.
      if (exitError) outEnded = true;
      finish();
    });
  });
}
