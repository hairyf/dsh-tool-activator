import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ActivateToolsParams, ActivationEnvelope } from './types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { activationContent } from './activation'
import { ACTIVATION_PRODUCER, ACTIVATION_VERSION, ACTIVATOR_TOOL_NAME } from './constants'

export function createActivatorTool(execute: (args: ActivateToolsParams, exec: ToolRunContext) => Promise<ActivationEnvelope>): ToolDefinition {
  return defineTool({
    name: ACTIVATOR_TOOL_NAME,
    description: 'Activate installed tools from the available_tools catalog to load their full schemas and usage instructions on the next model call. Activate all relevant identifiers together and explain why they are needed.',
    parameters: {
      identifiers: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Exact tool or tool-group identifiers from the available_tools catalog.',
      },
      reason: {
        type: 'string',
        required: true,
        description: 'A concise explanation of why these tools are needed for the user request.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          producer: { type: 'string', const: ACTIVATION_PRODUCER, required: true },
          version: { type: 'integer', const: ACTIVATION_VERSION, required: true },
          content: { type: 'string', required: true },
          success: { type: 'boolean', required: true },
          state: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              activatedTools: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    apiCount: { type: 'integer', required: true },
                    avatar: { type: 'string' },
                    identifier: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                  },
                },
              },
              activatedSkills: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    description: { type: 'string', required: true },
                    source: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    hasResources: { type: 'boolean', required: true },
                    provider: { type: 'string' },
                    instructions: { type: 'string' },
                  },
                },
              },
              alreadyActive: { type: 'array', items: { type: 'string' }, required: true },
              notFound: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
        },
      },
      render: (_args, value) => activationContent(value),
      presentationMeta: (_args, value) => value,
    },
    execute,
  })
}
