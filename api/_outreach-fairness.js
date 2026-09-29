// Alternate owners after successful work; retain follow-up priority within each owner.
export function fairCandidates(rows, journal = []) {
 const last = [...journal].reverse().find(e => e.status === 'verified');
 return [...rows].sort((a, b) => {
  if (a.owner !== b.owner && last) return Number(a.owner === last.owner) - Number(b.owner === last.owner);
  return (b.sentTouches || 0) - (a.sentTouches || 0);
 });
}
