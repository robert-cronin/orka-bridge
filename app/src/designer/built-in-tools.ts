// Orka KnownBuiltInToolNames union at image pin 7916cd1c8c083ade6b10df6ba408f854d930190c.
// This is a naming map, not a claim that a workspace has enabled each tool.
export const builtInTools: Readonly<Record<string, string>> = {
  web_fetch: 'Read a web page', web_search: 'Search the web',
  file_read: 'Read a file', file_write: 'Write a file', code_exec: 'Run code',
  request_approval: 'Ask for approval', reply_in_conversation: 'Reply in a conversation',
  delegate_task: 'Delegate a task',
  wait_for_tasks: 'Wait for tasks', create_container_task: 'Run a task in a container',
  cancel_task: 'Cancel a task', send_message: 'Send a message', check_messages: 'Read messages',
  create_pull_request: 'Open a pull request', check_pull_request_ci: 'Check pull request checks',
  merge_pull_request: 'Merge a pull request', auto_merge_pull_request: 'Set a pull request to merge',
  review_pull_request: 'Review a pull request', post_review_comment: 'Comment on a review',
  check_pr_review_marker: 'Check a review marker', list_issues: 'List issues',
  list_pull_requests: 'List pull requests', get_issue: 'Read an issue', comment_on_issue: 'Comment on an issue',
  create_agent: 'Create an agent', delete_agent: 'Delete an agent', update_agent: 'Change an agent',
  update_plan: 'Update a plan', recall_memory: 'Recall a memory', remember: 'Save a memory',
  propose_memory: 'Suggest a memory', search_transcript: 'Search past conversations',
  create_ai_task: 'Create an AI task', create_pr_monitor: 'Watch a pull request',
  create_agent_task: 'Give an agent a task', check_task_progress: 'Check task progress',
  fetch_task_output: 'Read a task’s output', wait_for_task: 'Wait for a task',
  list_agents: 'List agents', list_tools: 'List tools', list_tasks: 'List tasks',
  list_connections: 'List connected accounts',
  create_tool: 'Create a tool', delete_tool: 'Delete a tool', delete_session: 'Delete a conversation',
};
