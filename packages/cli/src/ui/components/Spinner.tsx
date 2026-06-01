import { Text } from 'ink'
import React, { useState, useEffect, useRef } from 'react'
import { spinnerFrames, colors } from '../theme.js'

interface SpinnerProps {
  /** 状态文本 */
  label?: string
  /** 启动时间戳 (用于 stall 检测) */
  startTime?: number
}

/**
 * 加载动画组件 —— 使用 braille spinner 帧，超时变色提醒。
 * - 正常: cyan
 * - >15s: yellow (可能较慢)
 * - >45s: red (异常)
 */
export function Spinner({ label = '思考中...', startTime }: SpinnerProps): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const start = startTime ?? Date.now()
    intervalRef.current = setInterval(() => {
      setFrameIndex((i) => (i + 1) % spinnerFrames.length)
      setElapsed(Date.now() - start)
    }, 80)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [startTime])

  // 根据耗时选择颜色
  const color = elapsed > 45_000 ? colors.error : elapsed > 15_000 ? colors.warning : colors.primary

  const frame = spinnerFrames[frameIndex]
  const elapsedStr = elapsed > 3000 ? ` (${Math.round(elapsed / 1000)}s)` : ''

  return (
    <Text color={color}>
      {frame} {label}
      {elapsedStr}
    </Text>
  )
}
