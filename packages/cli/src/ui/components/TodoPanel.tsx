import { Box, Text } from 'ink'
import React from 'react'
import type { TodoItem } from '@mech-code/middleware'
import { colors } from '../theme.js'

interface TodoPanelProps {
  todos: TodoItem[]
}

export function TodoPanel({ todos }: TodoPanelProps): React.ReactElement | null {
  const visible = todos.filter((todo) => todo.status !== 'completed')
  if (visible.length === 0) return null

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={colors.accent} bold>
        Todos
      </Text>
      {visible.map((todo, index) => (
        <Text
          key={`${todo.status}-${todo.content}-${index}`}
          color={todo.status === 'in_progress' ? colors.warning : colors.muted}
        >
          {todo.status === 'in_progress' ? '→' : '•'}{' '}
          {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
        </Text>
      ))}
    </Box>
  )
}
