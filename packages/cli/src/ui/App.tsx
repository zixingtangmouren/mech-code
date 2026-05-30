import { Box, Text } from 'ink'
import React from 'react'

export function App(): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        mech-code
      </Text>
      <Text color="gray">Interactive AI assistant. Type your message to begin.</Text>
    </Box>
  )
}
