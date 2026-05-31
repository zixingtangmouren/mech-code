/**
 * 计算两个字符串之间的 Levenshtein 编辑距离。
 * 使用动态规划，空间优化为单行数组。
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // 确保 a 是较短的字符串（减少空间）
  if (a.length > b.length) {
    ;[a, b] = [b, a]
  }

  const aLen = a.length
  const bLen = b.length
  let prev = Array.from({ length: aLen + 1 }, (_, i) => i)
  let curr = new Array<number>(aLen + 1)

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[i] = Math.min(
        prev[i]! + 1, // 删除
        curr[i - 1]! + 1, // 插入
        prev[i - 1]! + cost, // 替换
      )
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[aLen]!
}
