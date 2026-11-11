import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ActivateToolsParams, ActivationEnvelope, DeactivateToolsParams, GroupingToolParams, GroupingToolResult, ReleaseReceipt } from './types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { activationContent } from './activation'
import { ACTIVATION_PRODUCER, ACTIVATION_VERSION, ACTIVATOR_TOOL_NAME, DEACTIVATOR_TOOL_NAME, GROUPING_TOOL_NAME } from './constants'
import { releaseContent } from './release'

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
                    tools: { type: 'array', items: { type: 'string' } },
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

/**
 * The release tool: it gives the session's tool set back the entries the model
 * no longer needs.
 *
 * The description carries the rules the model cannot guess: a group is
 * released by its identifier, a bare tool name only when no activated group
 * provides it, and the always-loaded tools are out of reach. Releasing needs no
 * approval: it only ever takes schemas away.
 */
export function createDeactivatorTool(execute: (args: DeactivateToolsParams, exec: ToolRunContext) => Promise<ReleaseReceipt>): ToolDefinition {
  return defineTool({
    name: DEACTIVATOR_TOOL_NAME,
    description: 'Release the tools this session activated so their schemas stop occupying the context. Call it once with the identifiers of the entries you no longer need and a concise reason. A group is released by its identifier; a tool name may be released on its own only when no activated group provides it, and is refused otherwise. The basic tools, the locked tools and the catalog tools themselves cannot be released. Releasing an entry that is not activated succeeds without changing anything, so a retry is harmless.',
    parameters: {
      identifiers: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Exact identifiers of the activated entries, or the tool names that no activated group provides.',
      },
      reason: {
        type: 'string',
        required: true,
        description: 'A concise explanation of why these tools are no longer needed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          released: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              identifiers: { type: 'array', items: { type: 'string' }, required: true },
              toolNames: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
          refused: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                identifier: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          notFound: { type: 'array', items: { type: 'string' }, required: true },
          alreadyReleased: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => releaseContent(value),
      presentationMeta: (_args, value) => value,
    },
    execute,
  })
}

/**
 * The grouping tool reads and edits the groups of the current scope. It is the one
 * tool that reshapes the catalog, so its trigger rule is written into the
 * description itself: the model has to be told, every time it sees the tool, that
 * regrouping is the user's decision and never the model's own idea.
 */
export function createGroupingTool(execute: (args: GroupingToolParams, exec: ToolRunContext) => Promise<GroupingToolResult>): ToolDefinition {
  return defineTool({
    name: GROUPING_TOOL_NAME,
    description: 'Inspect and edit the tool groups of the current scope. Call this tool only when the user explicitly asks to organize, regroup, or rearrange the tools into groups; never regroup the catalog on your own initiative. action "list" reports the current groups with their members (a member flagged "missing" no longer exists in this scope), the unclaimed tools that are free to be grouped, the basic tools that are always on, and the locked tools that no group may claim. action "apply" writes the group edits given in "ops": "add" creates a group, "update" rewrites the name, the description or the whole membership of an existing group and gives it the new identifier "rename" asks for, and "remove" deletes a group. The group "basic" always exists and carries the tools that are always loaded: only "update" changes its members, and "add" or "remove" on it is refused. The whole batch is written or nothing is: a batch with one refused operation is refused as a whole, reports every problem at once, and leaves the groups exactly as they were. Moving a tool into another group is one call that removes the old group and adds the new one.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'apply'],
        required: true,
        description: '"list" reads the current grouping state; "apply" writes the group edits in ops.',
      },
      ops: {
        type: 'array',
        description: 'Group edits, each addressed by the identifier of the group it creates, rewrites, or deletes.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: {
              type: 'string',
              enum: ['add', 'update', 'remove'],
              required: true,
              description: 'Whether the edit adds the group, updates it, or removes it.',
            },
            identifier: {
              type: 'string',
              required: true,
              description: 'Identifier of the group this edit addresses: the group to create, to rewrite or to delete. "basic" is reserved for the always-loaded tools.',
            },
            name: {
              type: 'string',
              description: 'Display name of the group.',
            },
            description: {
              type: 'string',
              description: 'One sentence describing what the group is for.',
            },
            tools: {
              type: 'array',
              description: 'Tool names the group carries; on "update" this replaces the whole membership.',
              items: { type: 'string' },
            },
            rename: {
              type: 'string',
              description: 'The identifier this group gets instead of the one it carries; only an update may rename a group, and the new identifier has to be free.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'apply'], required: true },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                identifier: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                tools: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true },
                      missing: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
          unclaimed: { type: 'array', items: { type: 'string' } },
          basic: { type: 'array', items: { type: 'string' } },
          locked: { type: 'array', items: { type: 'string' } },
          problems: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                groupIdentifier: { type: 'string', required: true },
                groupIndex: { type: 'integer' },
                opIndex: { type: 'integer' },
                conflictingGroupIndex: { type: 'integer' },
                tool: { type: 'string' },
              },
            },
          },
          receipt: {
            type: 'object',
            additionalProperties: false,
            properties: {
              created: { type: 'array', required: true, items: { type: 'string' } },
              updated: { type: 'array', required: true, items: { type: 'string' } },
              removed: { type: 'array', required: true, items: { type: 'string' } },
              renamed: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    from: { type: 'string', required: true },
                    to: { type: 'string', required: true },
                  },
                },
              },
              unchanged: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          migrated: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute,
  })
}
