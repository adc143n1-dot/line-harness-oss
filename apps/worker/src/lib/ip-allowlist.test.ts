import { describe, it, expect } from 'vitest';
import {
  isValidIpOrCidr,
  ipMatches,
  ipMatchesAny,
  normalizeEntries,
  parseIp,
} from './ip-allowlist.js';

describe('parseIp', () => {
  it('parses IPv4', () => {
    expect(parseIp('192.168.0.1')).toEqual({ family: 4, value: 0xc0a80001 });
  });
  it('parses IPv6', () => {
    const r = parseIp('2001:db8::1');
    expect(r?.family).toBe(6);
  });
  it('normalizes IPv4-mapped IPv6 to IPv4', () => {
    expect(parseIp('::ffff:192.0.2.1')).toEqual({ family: 4, value: 0xc0000201 });
  });
  it('rejects garbage', () => {
    expect(parseIp('not-an-ip')).toBeNull();
    expect(parseIp('999.1.1.1')).toBeNull();
    expect(parseIp('192.168.0')).toBeNull();
  });
});

describe('isValidIpOrCidr', () => {
  it('accepts plain IPs and CIDRs', () => {
    expect(isValidIpOrCidr('203.0.113.5')).toBe(true);
    expect(isValidIpOrCidr('203.0.113.0/24')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::1')).toBe(true);
  });
  it('rejects invalid prefixes and addresses', () => {
    expect(isValidIpOrCidr('203.0.113.0/33')).toBe(false);
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false);
    expect(isValidIpOrCidr('203.0.113.0/abc')).toBe(false);
    expect(isValidIpOrCidr('')).toBe(false);
    expect(isValidIpOrCidr('hello')).toBe(false);
  });
});

describe('ipMatches — IPv4', () => {
  it('exact single address', () => {
    expect(ipMatches('203.0.113.5', '203.0.113.5')).toBe(true);
    expect(ipMatches('203.0.113.6', '203.0.113.5')).toBe(false);
  });
  it('CIDR range', () => {
    expect(ipMatches('203.0.113.42', '203.0.113.0/24')).toBe(true);
    expect(ipMatches('203.0.114.1', '203.0.113.0/24')).toBe(false);
    expect(ipMatches('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipMatches('11.1.2.3', '10.0.0.0/8')).toBe(false);
  });
  it('/32 behaves like an exact address', () => {
    expect(ipMatches('203.0.113.5', '203.0.113.5/32')).toBe(true);
    expect(ipMatches('203.0.113.6', '203.0.113.5/32')).toBe(false);
  });
  it('/0 matches everything in-family', () => {
    expect(ipMatches('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });
});

describe('ipMatches — IPv6', () => {
  it('exact and CIDR', () => {
    expect(ipMatches('2001:db8::1', '2001:db8::1')).toBe(true);
    expect(ipMatches('2001:db8::abcd', '2001:db8::/32')).toBe(true);
    expect(ipMatches('2001:db9::1', '2001:db8::/32')).toBe(false);
  });
  it('does not cross address families', () => {
    expect(ipMatches('203.0.113.5', '2001:db8::/32')).toBe(false);
    expect(ipMatches('2001:db8::1', '203.0.113.0/24')).toBe(false);
  });
  it('IPv4-mapped client matches an IPv4 entry', () => {
    expect(ipMatches('::ffff:203.0.113.5', '203.0.113.0/24')).toBe(true);
  });
});

describe('ipMatchesAny', () => {
  it('true if any entry matches', () => {
    const list = ['10.0.0.0/8', '203.0.113.5', '2001:db8::/32'];
    expect(ipMatchesAny('203.0.113.5', list)).toBe(true);
    expect(ipMatchesAny('10.9.9.9', list)).toBe(true);
    expect(ipMatchesAny('2001:db8::99', list)).toBe(true);
    expect(ipMatchesAny('8.8.8.8', list)).toBe(false);
  });
  it('empty list matches nothing', () => {
    expect(ipMatchesAny('8.8.8.8', [])).toBe(false);
  });
});

describe('normalizeEntries', () => {
  it('trims, drops blanks, dedupes, and separates invalid', () => {
    const { entries, invalid } = normalizeEntries([
      ' 203.0.113.5 ',
      '203.0.113.5',
      '',
      '10.0.0.0/8',
      'garbage',
      '203.0.113.0/33',
    ]);
    expect(entries).toEqual(['203.0.113.5', '10.0.0.0/8']);
    expect(invalid).toEqual(['garbage', '203.0.113.0/33']);
  });
});
