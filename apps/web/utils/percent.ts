/** bp（基点）→ 百分比的展示格式化；与补充包概率公示一致，只做展示换算，不参与任何统计或结算。 */
export function formatBasisPoints(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 1)}%`;
}
