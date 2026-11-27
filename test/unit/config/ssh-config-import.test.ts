import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { hostMatches, resolveHost, listAliases, importSshHosts, renderImport } from '../../../src/config/ssh-config-import.js';
import { configSchema } from '../../../src/config/schema.js';

let home: string;
let cfg: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ssh-cfg-import-'));
  mkdirSync(join(home, '.ssh', 'conf.d'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'dummy');
  writeFileSync(join(home, '.ssh', 'work_key'), 'dummy');
  writeFileSync(join(home, '.ssh', 'conf.d', 'extra.conf'), 'Host included\n  HostName 192.0.2.9\n  User inc\n');
  cfg = join(home, '.ssh', 'config');
  writeFileSync(cfg, `
Include conf.d/*.conf

Host bastion
  HostName 192.0.2.1
  User ops
  IdentityFile ~/.ssh/work_key
  ControlMaster auto

Host inner
  HostName 10.0.0.5
  User = alice
  Port 2222
  ProxyJump bastion
  LocalForward 8080 localhost:80

Host spelled
  HostName 10.0.0.6
  User bob
  ProxyCommand ssh -o ControlPath=none -W %h:%p bastion

Host behind-http
  HostName 203.0.113.7
  Port 14973
  User carol
  ProxyCommand nc -X connect -x 127.0.0.1:7890 %h %p
  ConnectTimeout 15

Host chain
  HostName 10.0.0.7
  ProxyJump bastion,inner

Host *.corp !skip.corp
  User corpuser

Host *
  User fallback
  Port 22
`);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('ssh_config resolution', () => {
  it('matches Host patterns as OpenSSH does', () => {
    expect(hostMatches(['*.corp', '!skip.corp'], 'a.corp')).toBe(true);
    expect(hostMatches(['*.corp', '!skip.corp'], 'skip.corp')).toBe(false);
    expect(hostMatches(['web?'], 'web1')).toBe(true);
  });

  it('keeps the first value of a keyword, so specific blocks beat Host *', () => {
    const { options } = resolveHost('inner', cfg, home);
    expect(options.user).toEqual(['alice']);
    expect(options.port).toEqual(['2222']);
    expect(resolveHost('x.corp', cfg, home).options.user).toEqual(['corpuser']);
    expect(resolveHost('skip.corp', cfg, home).options.user).toEqual(['fallback']);
  });

  it('follows Include and lists literal aliases only', () => {
    expect(listAliases(cfg, home)).toEqual(['included', 'bastion', 'inner', 'spelled', 'behind-http', 'chain']);
  });
});

describe('importSshHosts', () => {
  const load = (aliases: string[]) => {
    const out = importSshHosts(aliases, cfg, home);
    const parsed = configSchema.parse(parseTOML(out.map((p) => p.toml).join('\n\n')));
    return { out, profiles: parsed.profiles };
  };

  it('produces profiles the config schema accepts', () => {
    const { profiles } = load(['bastion', 'inner', 'spelled', 'behind-http', 'chain', 'included']);
    const by = Object.fromEntries(profiles.map((p) => [p.name, p]));
    expect(by.bastion).toMatchObject({ host: '192.0.2.1', user: 'ops', auth: 'key', keyRef: join(home, '.ssh', 'work_key') });
    expect(by.inner).toMatchObject({ host: '10.0.0.5', port: 2222, via: 'bastion', keyRef: join(home, '.ssh', 'id_ed25519') });
    expect(by['behind-http']).toMatchObject({ proxyCommand: 'nc -X connect -x 127.0.0.1:7890 %h %p', connectTimeoutMs: 15000 });
    expect(by.included).toMatchObject({ host: '192.0.2.9', user: 'inc' });
  });

  it('turns an ssh -W ProxyCommand to an imported host into via', () => {
    expect(load(['bastion', 'spelled']).profiles[1].via).toBe('bastion');
    // ...but keeps the command when the hop is not part of the import.
    expect(load(['spelled']).profiles[0].proxyCommand).toBe('ssh -o ControlPath=none -W %h:%p bastion');
  });

  it('walks a ProxyJump chain or an outside hop with the system ssh', () => {
    expect(load(['chain']).profiles[0].proxyCommand).toBe('ssh -W %h:%p -J bastion inner');
    expect(load(['inner']).profiles[0].proxyCommand).toBe('ssh -W %h:%p bastion');
  });

  it('reports what it could not carry over instead of dropping it', () => {
    const text = renderImport(importSshHosts(['inner', 'nope'], cfg, home));
    expect(text).toMatch(/# NOTE inner: localforward is not carried over/);
    expect(text).toMatch(/# NOTE nope: "nope" is not a Host alias/);
    expect(text).not.toMatch(/controlmaster/);
  });
});
