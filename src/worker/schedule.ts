/** Lead indices in progressive order: coarse strides first, no duplicates. */
export function progressiveLeadOrder(numLeads: number, passes: readonly number[]): number[][] {
  const seen = new Set<number>();
  return passes.map((stride) => {
    const pass: number[] = [];
    for (let i = 0; i < numLeads; i += stride) {
      if (!seen.has(i)) {
        seen.add(i);
        pass.push(i);
      }
    }
    const last = numLeads - 1;
    if (!seen.has(last)) {
      seen.add(last);
      pass.push(last);
    }
    return pass;
  });
}
