import { describe, expect, it } from 'vitest';
import { isAuthorizedCron, minuteRunKey } from '@/lib/pipeline/run';

describe('minuteRunKey — 중복 cron 실행 방지', () => {
  it('같은 분에는 같은 키를 준다', () => {
    const a = minuteRunKey('collect', new Date('2026-07-31T05:20:10Z'));
    const b = minuteRunKey('collect', new Date('2026-07-31T05:20:59Z'));
    expect(a).toBe(b);
  });

  it('분이 바뀌면 다른 키를 준다', () => {
    const a = minuteRunKey('collect', new Date('2026-07-31T05:20:10Z'));
    const b = minuteRunKey('collect', new Date('2026-07-31T05:21:10Z'));
    expect(a).not.toBe(b);
  });

  it('작업별로 키가 분리된다', () => {
    const at = new Date('2026-07-31T05:20:00Z');
    expect(minuteRunKey('collect', at)).not.toBe(minuteRunKey('analyze', at));
  });
});

describe('isAuthorizedCron', () => {
  const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('올바른 Bearer 토큰을 통과시킨다', () => {
    withEnv({ CRON_SECRET: 'sekret', NODE_ENV: 'production' }, () => {
      const request = new Request('https://x/api/cron/collect', {
        headers: { authorization: 'Bearer sekret' },
      });
      expect(isAuthorizedCron(request)).toBe(true);
    });
  });

  it('토큰이 틀리면 거부한다', () => {
    withEnv({ CRON_SECRET: 'sekret', NODE_ENV: 'production' }, () => {
      const request = new Request('https://x/api/cron/collect', {
        headers: { authorization: 'Bearer wrong' },
      });
      expect(isAuthorizedCron(request)).toBe(false);
    });
  });

  it('토큰이 없으면 거부한다', () => {
    withEnv({ CRON_SECRET: 'sekret', NODE_ENV: 'production' }, () => {
      expect(isAuthorizedCron(new Request('https://x/api/cron/collect'))).toBe(false);
    });
  });

  it('CRON_SECRET 미설정 + 운영 환경이면 거부한다', () => {
    withEnv({ CRON_SECRET: undefined, NODE_ENV: 'production' }, () => {
      expect(isAuthorizedCron(new Request('https://x/api/cron/collect'))).toBe(false);
    });
  });

  it('CRON_SECRET 미설정 + 개발 환경이면 통과시킨다', () => {
    withEnv({ CRON_SECRET: undefined, NODE_ENV: 'development' }, () => {
      expect(isAuthorizedCron(new Request('https://x/api/cron/collect'))).toBe(true);
    });
  });
});
