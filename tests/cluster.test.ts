import { describe, expect, it } from 'vitest';
import {
  clusterArticles,
  evaluateMerge,
  hoursBetween,
  type ClusterableArticle,
} from '@/lib/news/cluster';

const BASE = '2026-07-31T05:00:00.000Z';

function article(id: string, title: string, offsetHours = 0): ClusterableArticle {
  return {
    id,
    cleaned_title: title,
    published_at: new Date(Date.parse(BASE) + offsetHours * 3_600_000).toISOString(),
  };
}

describe('evaluateMerge', () => {
  it('같은 사건을 다룬 두 기사를 병합한다', () => {
    const verdict = evaluateMerge(
      { title: '미국, 중국산 변압기에 관세 부과 검토', publishedAt: BASE },
      { title: '미국 정부, 중국산 변압기 관세 부과 추진', publishedAt: BASE },
    );
    expect(verdict.merge).toBe(true);
  });

  it('서로 다른 사건은 병합하지 않는다', () => {
    const verdict = evaluateMerge(
      { title: '미국, 중국산 변압기 관세 부과 검토', publishedAt: BASE },
      { title: '포스코 포항제철소 화재로 생산 중단', publishedAt: BASE },
    );
    expect(verdict.merge).toBe(false);
    expect(verdict.reason).toBe('few_shared_tokens');
  });

  it('같은 산업의 다른 사건은 병합하지 않는다 (과잉 병합 방지)', () => {
    const verdict = evaluateMerge(
      { title: 'LG에너지솔루션 미국 배터리 공장 증설 발표', publishedAt: BASE },
      { title: '삼성SDI 헝가리 배터리 공장 화재 발생', publishedAt: BASE },
    );
    expect(verdict.merge).toBe(false);
  });

  it('시간이 멀리 떨어지면 아무리 비슷해도 병합하지 않는다', () => {
    const verdict = evaluateMerge(
      { title: '미국, 중국산 변압기에 관세 부과 검토', publishedAt: BASE },
      {
        title: '미국, 중국산 변압기에 관세 부과 검토',
        publishedAt: new Date(Date.parse(BASE) + 48 * 3_600_000).toISOString(),
      },
    );
    expect(verdict.merge).toBe(false);
    expect(verdict.reason).toBe('too_far_apart');
  });

  it('공유 토큰이 하나뿐이면 병합하지 않는다', () => {
    const verdict = evaluateMerge(
      { title: '관세 인상', publishedAt: BASE },
      { title: '관세 철폐', publishedAt: BASE },
    );
    expect(verdict.merge).toBe(false);
    expect(verdict.reason).toBe('few_shared_tokens');
  });
});

describe('clusterArticles', () => {
  it('동일 사건 기사 3건을 하나로 묶는다', () => {
    const clusters = clusterArticles([
      article('a', '미국, 중국산 변압기에 관세 부과 검토'),
      article('b', '미국 정부, 중국산 변압기 관세 부과 추진', 1),
      article('c', '미국, 중국산 변압기 관세 부과 최종 검토', 2),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(3);
  });

  it('서로 다른 사건은 별도 클러스터로 남긴다', () => {
    const clusters = clusterArticles([
      article('a', '미국, 중국산 변압기에 관세 부과 검토'),
      article('b', '포스코 포항제철소 화재로 생산 중단', 1),
      article('c', '국제 구리 가격 사상 최고치 경신', 2),
    ]);
    expect(clusters).toHaveLength(3);
  });

  it('가장 먼저 발행된 기사를 primary 로 삼는다', () => {
    const clusters = clusterArticles([
      article('late', '미국 정부, 중국산 변압기 관세 부과 추진', 3),
      article('early', '미국, 중국산 변압기에 관세 부과 검토', 0),
    ]);
    expect(clusters[0].primary.id).toBe('early');
  });

  it('체인 병합을 허용하지 않는다', () => {
    // A~B 는 비슷하고 B~C 도 비슷하지만 A~C 는 다른 사건인 구성.
    // primary(A) 와만 비교하므로 C 는 A 클러스터에 들어가지 않아야 한다.
    const clusters = clusterArticles([
      article('a', '미국 중국산 변압기 관세 부과 검토'),
      article('b', '미국 중국산 변압기 관세 부과 검토 배터리 영향', 1),
      article('c', '배터리 소재 가격 급등 지속 전망', 2),
    ]);
    const withC = clusters.find((cl) => cl.members.some((m) => m.id === 'c'));
    const withA = clusters.find((cl) => cl.members.some((m) => m.id === 'a'));
    expect(withC).not.toBe(withA);
  });

  it('빈 입력은 빈 결과', () => {
    expect(clusterArticles([])).toEqual([]);
  });
});

describe('hoursBetween', () => {
  it('절대값을 돌려준다', () => {
    expect(hoursBetween('2026-07-31T05:00:00Z', '2026-07-31T08:00:00Z')).toBe(3);
    expect(hoursBetween('2026-07-31T08:00:00Z', '2026-07-31T05:00:00Z')).toBe(3);
  });
});
