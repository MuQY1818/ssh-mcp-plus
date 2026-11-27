import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, isAbsolute, dirname, basename } from 'node:path';

/**
 * Turn `~/.ssh/config` host aliases into `[[profiles]]` blocks, so a host that already works with
 * `ssh <alias>` does not have to be described a second time by hand.
 *
 * It reads the subset of ssh_config that decides where and how a connection goes, with OpenSSH's
 * rules: a keyword's first value wins, `Host` patterns match with `*`, `?` and `!`, and `Include`
 * is followed. `Match` blocks are skipped (they depend on runtime state) and reported, like every
 * other option that changes the connection and has no equivalent here. The output is TOML text
 * for the operator to review and paste: nothing is written, and no host is contacted.
 */

export interface SshHostOptions {
  [keyword: string]: string[] | undefined;
}

export interface ImportedProfile {
  alias: string;
  toml: string;
  notes: string[];
}

/** Keywords that change behaviour but have no profile equivalent: reported, not silently dropped. */
const REPORTED = new Set([
  'localforward', 'remoteforward', 'dynamicforward', 'forwardagent', 'certificatefile',
  'hostkeyalias', 'pkcs11provider', 'securitykeyprovider', 'requesttty', 'remotecommand',
]);
// ControlMaster & co. are left out on purpose: ssh-mcp keeps its connections open by itself.
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/** OpenSSH Host matching: any positive pattern matches and no negated one does. */
export function hostMatches(patterns: string[], alias: string): boolean {
  let positive = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(alias)) return false;
    } else if (globToRegExp(p).test(alias)) {
      positive = true;
    }
  }
  return positive;
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

interface Line { keyword: string; args: string[]; file: string }

/** Flatten a config and its Includes into lines; Host/Match lines are kept as section markers. */
function readLines(file: string, home: string, depth = 0, seen = new Set<string>()): Line[] {
  if (depth > 16 || seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const lines: Line[] = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = raw.trim();
    if (!text || text.startsWith('#')) continue;
    const eq = /^(\S+?)\s*=\s*(.*)$/.exec(text);
    const tokens = eq && !/\s/.test(eq[1]) ? [eq[1], ...tokenize(eq[2])] : tokenize(text);
    const keyword = tokens[0].toLowerCase();
    const args = tokens.slice(1);
    if (keyword === 'include') {
      for (const pattern of args) {
        let path = expandHome(pattern, home);
        if (!isAbsolute(path)) path = join(home, '.ssh', path);
        const dir = dirname(path);
        const re = globToRegExp(basename(path));
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : [];
        for (const f of files) lines.push(...readLines(f, home, depth + 1, seen));
      }
      continue;
    }
    lines.push({ keyword, args, file });
  }
  return lines;
}

/** Every option that applies to `alias`, first value winning, as OpenSSH resolves it. */
export function resolveHost(alias: string, configPath: string, home = homedir()): { options: SshHostOptions; skippedMatch: boolean; defined: boolean } {
  const options: SshHostOptions = {};
  let active = true; // lines before the first Host apply to every host
  let skippedMatch = false;
  let defined = false;
  for (const { keyword, args } of readLines(configPath, home)) {
    if (keyword === 'host') {
      active = hostMatches(args, alias);
      if (active && args.some((a) => a.toLowerCase() === alias.toLowerCase())) defined = true;
      continue;
    }
    if (keyword === 'match') {
      active = false;
      skippedMatch = true;
      continue;
    }
    if (!active) continue;
    // IdentityFile accumulates; everything else keeps its first value.
    if (keyword === 'identityfile') (options[keyword] ??= []).push(args.join(' '));
    else if (options[keyword] === undefined) options[keyword] = args;
  }
  return { options, skippedMatch, defined };
}

/** All literal aliases (no wildcards) in the order they are defined. */
export function listAliases(configPath: string, home = homedir()): string[] {
  const out: string[] = [];
  for (const { keyword, args } of readLines(configPath, home)) {
    if (keyword !== 'host') continue;
    for (const a of args) if (!/[*?!]/.test(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

function q(s: string): string {
  return JSON.stringify(s);
}

export function importSshHosts(aliases: string[], configPath = join(homedir(), '.ssh', 'config'), home = homedir()): ImportedProfile[] {
  const selected = new Set(aliases);
  return aliases.map((alias) => {
    const { options: o, skippedMatch, defined } = resolveHost(alias, configPath, home);
    const notes: string[] = [];
    if (!defined) notes.push(`"${alias}" is not a Host alias in ${configPath}; only wildcard defaults applied`);
    if (skippedMatch) notes.push('Match blocks were skipped; check they do not change this host');
    const first = (k: string) => o[k]?.[0];
    const lines = ['[[profiles]]', `name = ${q(alias)}`];
    const host = first('hostname') ?? alias;
    lines.push(`host = ${q(host.replace(/%h/g, alias))}`);
    const port = Number(first('port') ?? 22);
    if (port !== 22) lines.push(`port = ${port}`);
    lines.push(`user = ${q(first('user') ?? userInfo().username)}`);

    const keys = (o.identityfile ?? []).map((k) => expandHome(k, home)).filter((k) => k.toLowerCase() !== 'none');
    if (keys.length > 1) notes.push(`several IdentityFile lines; using the first (${keys[0]})`);
    const key = keys[0] ?? DEFAULT_KEYS.map((k) => join(home, '.ssh', k)).find((k) => existsSync(k));
    if (key) {
      if (!existsSync(key)) notes.push(`key ${key} does not exist`);
      lines.push('auth = "key"', `keyRef = ${q(key)}`);
    } else {
      lines.push('auth = "agent"');
      notes.push('no IdentityFile and no default key found; using the SSH agent');
    }

    const jump = first('proxyjump');
    const command = o.proxycommand?.join(' ');
    if (jump && jump.toLowerCase() !== 'none') {
      const hops = jump.split(',');
      if (hops.length === 1 && selected.has(hops[0]) && !hops[0].includes('@')) {
        lines.push(`via = ${q(hops[0])}`);
      } else {
        // A hop outside this import, or a chain: let the system ssh walk it.
        lines.push(`proxyCommand = ${q(`ssh -W %h:%p ${hops.length > 1 ? `-J ${hops.slice(0, -1).join(',')} ` : ''}${hops[hops.length - 1]}`)}`);
      }
    } else if (command && /^ssh\b.*\s-W\s+%h:%p\s+(\S+)$/.test(command) && selected.has(/(\S+)$/.exec(command)![1])) {
      // `ssh ... -W %h:%p <alias>` to a host in this import is a ProxyJump spelled out: use via,
      // so the hop is one shared ssh-mcp connection rather than a system ssh per connect.
      const hop = /(\S+)$/.exec(command)![1];
      lines.push(`via = ${q(hop)}`);
      notes.push(`ProxyCommand "${command}" became via = "${hop}"`);
    } else if (command && command.toLowerCase() !== 'none') {
      const unsupported = command.match(/%[^hprn%]/g);
      if (unsupported) notes.push(`ProxyCommand uses ${[...new Set(unsupported)].join(' ')}, which proxyCommand does not expand; edit it`);
      lines.push(`proxyCommand = ${q(command)}`);
    }

    const ct = Number(first('connecttimeout'));
    if (ct >= 1 && ct <= 600) lines.push(`connectTimeoutMs = ${ct * 1000}`);

    for (const k of Object.keys(o)) {
      if (REPORTED.has(k)) notes.push(`${k} is not carried over (no profile equivalent)`);
    }
    return { alias, toml: lines.join('\n'), notes };
  });
}

/** The whole output of `--importSshConfig`: profiles with their notes as TOML comments. */
export function renderImport(profiles: ImportedProfile[]): string {
  return profiles
    .map((p) => [...p.notes.map((n) => `# NOTE ${p.alias}: ${n}`), p.toml].join('\n'))
    .join('\n\n') + '\n';
}
