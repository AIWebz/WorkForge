// Reporting computed from real task, activity and approval records.
import { chat, userMessage } from './ai.js';

export async function computeStats(db, { employeeId = null, since = 0 } = {}) {
  const [tasksAll, approvalsAll, employees, activityAll] = await Promise.all([
    db.all('tasks'), db.all('approvals'), db.all('employees'), db.all('activity'),
  ]);
  const tasks = tasksAll.filter((t) => (!employeeId || t.employeeId === employeeId) && t.createdAt >= since);
  const approvals = approvalsAll.filter((a) => (!employeeId || a.employeeId === employeeId) && a.createdAt >= since);
  const activity = activityAll.filter((a) => (!employeeId || a.employeeId === employeeId) && a.ts >= since);

  const count = (st) => tasks.filter((t) => t.status === st).length;
  const finished = tasks.filter((t) => ['completed', 'failed', 'needs_attention'].includes(t.status));
  const completed = count('completed');
  const runs = tasks.flatMap((t) => t.scriptRuns || []);
  const minutesSaved = runs.reduce((a, r) => a + (r.status === 'success' ? r.estimatedMinutes || 0 : 0), 0);
  const metrics = {};
  for (const t of tasks) for (const [k, v] of Object.entries(t.metrics || {})) metrics[k] = (metrics[k] || 0) + v;
  const toolCalls = activity.filter((a) => a.type === 'tool_call').length;
  const toolErrors = activity.filter((a) => a.type === 'tool_error').length;

  const days = {};
  for (const t of tasks) {
    const d = new Date(t.createdAt).toISOString().slice(0, 10);
    days[d] = days[d] || { date: d, completed: 0, failed: 0, other: 0 };
    if (t.status === 'completed') days[d].completed++;
    else if (t.status === 'failed') days[d].failed++;
    else days[d].other++;
  }

  const perEmployee = employees.filter((e) => !employeeId || e.id === employeeId).map((e) => {
    const et = tasks.filter((t) => t.employeeId === e.id);
    const done = et.filter((t) => t.status === 'completed').length;
    const fin = et.filter((t) => ['completed', 'failed', 'needs_attention'].includes(t.status)).length;
    const er = et.flatMap((t) => t.scriptRuns || []);
    return {
      id: e.id, name: e.name, role: e.role, status: e.status,
      tasks: et.length, completed: done, failed: et.filter((t) => t.status === 'failed').length,
      successRate: fin ? Math.round((done / fin) * 1000) / 10 : null,
      minutesSaved: er.reduce((a, r) => a + (r.status === 'success' ? r.estimatedMinutes || 0 : 0), 0),
      scriptRuns: er.length,
    };
  });

  const scriptStats = {};
  for (const r of runs) {
    const s = (scriptStats[r.name] = scriptStats[r.name] || { name: r.name, runs: 0, success: 0, failed: 0, totalMs: 0 });
    s.runs++;
    if (r.status === 'success') s.success++; else s.failed++;
    s.totalMs += (r.endedAt || 0) - (r.startedAt || 0);
  }

  return {
    generatedAt: Date.now(), since, employeeId,
    tasks: { total: tasks.length, completed, failed: count('failed'), running: count('running') + count('queued'), waiting: count('waiting_approval'), paused: count('paused'), cancelled: count('cancelled'), needsAttention: count('needs_attention') },
    approvals: { pending: approvals.filter((a) => a.status === 'pending').length, approved: approvals.filter((a) => ['approved', 'edited'].includes(a.status)).length, rejected: approvals.filter((a) => a.status === 'rejected').length },
    successRate: finished.length ? Math.round((completed / finished.length) * 1000) / 10 : null,
    minutesSaved,
    scriptRuns: runs.length,
    toolCalls, toolErrors,
    metrics,
    tokens: tasks.reduce((a, t) => ({ input: a.input + (t.usage?.input || 0), output: a.output + (t.usage?.output || 0) }), { input: 0, output: 0 }),
    daily: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
    perEmployee,
    scripts: Object.values(scriptStats).sort((a, b) => b.runs - a.runs),
  };
}

export async function summarizeStats(ai, stats, { title = 'Workforce report', recentTasks = [] } = {}) {
  const r = await chat(ai, {
    system: 'You are the WorkForce reporting engine. Write concise, factual executive summaries strictly from the data provided. Never invent numbers. Use short paragraphs and bullet points (markdown).',
    messages: [userMessage(ai, `Write the "${title}" summary.\n\n<stats>\n${JSON.stringify(stats, null, 1)}\n</stats>\n\n<recent_tasks>\n${JSON.stringify(recentTasks.slice(0, 25).map((t) => ({ title: t.title, employee: t.employeeName, status: t.status, result: t.result, error: t.error })), null, 1)}\n</recent_tasks>\n\nCover: overall output, per-employee performance, notable outcomes and failures, pending approvals, and 2–3 recommendations.`)],
    maxTokens: 6000,
  });
  return r.text;
}
