import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { expandProxyCommand, spawnProxyCommand } from '../../../src/ssh/proxy-command.js';
import { loadConfigWithDigest } from '../../../src/config/loader.js';
import { CONNECTION_FIELDS } from '../../../src/config/reload-diff.js';
import { makeConfigDir, enforceAcl, type ConfigDir } from '../config/helpers.js';

const P = { name: 'jump-me', host: '10.0.0.5', port: 2222, user: 'alice' };
const posix = process.platform !== 'win32';

describe('expandProxyCommand', () => {
  it('substitutes the OpenSSH tokens', () => {
    expect(expandProxyCommand('nc -X connect -x 127.0.0.1:7890 %h %p', P)).toBe('nc -X connect -x 127.0.0.1:7890 10.0.0.5 2222');
    expect(expandProxyCommand('ssh -W %h:%p %r@bastion # %n 100%%', P)).toBe('ssh -W 10.0.0.5:2222 alice@bastion # jump-me 100%');
  });

  it('refuses a token it does not know rather than passing it to the shell', () => {
    expect(() => expandProxyCommand('nc %h %p %C', P)).toThrow(/unsupported token "%C"/);
  });
});

describe.runIf(posix)('spawnProxyCommand', () => {
  it('carries bytes both ways over the command stdio', async () => {
    const { sock, child } = await spawnProxyCommand({ ...P, proxyCommand: 'cat' });
    const exited = once(child, 'exit');
    const got: Buffer[] = [];
    sock.on('data', (b: Buffer) => got.push(b));
    sock.write('SSH-2.0-hello\r\n');
    sock.end();
    await once(sock, 'end');
    expect(Buffer.concat(got).toString()).toBe('SSH-2.0-hello\r\n');
    // EOF is delivered only after the process exited, so the exit status is already known.
    expect((await exited)[0]).toBe(0);
  });

  it('fails the socket with the tail of stderr when the proxy exits non-zero', async () => {
    const { sock } = await spawnProxyCommand({ ...P, proxyCommand: 'echo "CONNECT %h:%p refused" >&2; exit 7' });
    const [err] = (await once(sock, 'error')) as [Error];
    expect(err.message).toMatch(/exited with code 7: CONNECT 10\.0\.0\.5:2222 refused/);
  });

  it('reports the proxy failure instead of a bare end of stream', async () => {
    // stdout closes before the exit status is known; the socket must not end cleanly first.
    const { sock } = await spawnProxyCommand({ ...P, proxyCommand: 'exec 1>&-; echo "403 Forbidden" >&2; exit 1' });
    sock.resume();
    const [err] = (await once(sock, 'error')) as [Error];
    expect(err.message).toMatch(/exited with code 1: 403 Forbidden/);
  });

  it('kills the process when the socket is destroyed', async () => {
    const { sock, child } = await spawnProxyCommand({ ...P, proxyCommand: 'sleep 30' });
    sock.destroy();
    const [code, signal] = await once(child, 'exit');
    expect(code === null ? signal : code).toBe('SIGTERM');
  });

  it('rejects an unknown token before starting anything', async () => {
    await expect(spawnProxyCommand({ ...P, proxyCommand: 'nc %x' })).rejects.toThrow(/unsupported token/);
  });
});

describe('proxyCommand in the config schema', () => {
  let cfg: ConfigDir;
  afterEach(async () => { await cfg?.cleanup(); });

  const load = async (extra: string) => {
    cfg = await makeConfigDir('ssh-mcp-proxy-');
    const path = await cfg.write(`
[[profiles]]
name = "bastion"
host = "bastion.example"
user = "ops"

[[profiles]]
name = "inner"
host = "10.0.0.5"
user = "alice"
${extra}
`);
    return (await loadConfigWithDigest(path, enforceAcl())).config;
  };

  it('accepts and trims a command line', async () => {
    const config = await load('proxyCommand = "  nc -X connect -x 127.0.0.1:7890 %h %p  "');
    expect(config.profiles[1].proxyCommand).toBe('nc -X connect -x 127.0.0.1:7890 %h %p');
  });

  it('refuses a blank command instead of silently connecting direct', async () => {
    await expect(load('proxyCommand = "  "')).rejects.toThrow(/proxyCommand cannot be empty/);
  });

  it('refuses via and proxyCommand together', async () => {
    await expect(load('via = "bastion"\nproxyCommand = "nc %h %p"')).rejects.toThrow(/either via or proxyCommand/);
  });

  it('closes the live connection when the command changes on reload', () => {
    expect(CONNECTION_FIELDS).toContain('proxyCommand');
  });
});
