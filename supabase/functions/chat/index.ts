// supabase/functions/chat/index.ts
//
// EagleVision agent â€” tool-using chat function.
// Replaces the old streaming-only proxy. Single-user app: still RLS-safe via
// the caller's JWT, so the same code is multi-user-ready if you ever flip.
//
// Flow per request:
//   1. Verify caller's auth, build a Supabase client AS THAT USER.
//   2. Inject a system prompt with today's date and the user's project list
//      so the model can route by project name without an extra tool call.
//   3. Loop: call the Lovable AI Gateway with tools; if the model returns
//      tool_calls, execute them against the DB, feed results back, continue.
//   4. When the model returns plain text, send it back as JSON.
//
// Response shape:
//   { reply: string, touched: string[] }
//   `touched` lists table names changed (e.g. ["tasks","projects"]) so the
//   frontend can invalidate React Query caches selectively.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-5-mini";
const MAX_TOOL_ITERATIONS = 8;

// ---------------------------------------------------------------------------
// Tool schemas â€” these are sent to the model on every call.
// Keep descriptions tight; the model reads them to decide which tool to use.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "Create a new task. project_id is optional (omit = inbox). " +
        "parent_task_id makes it a subtask. priority: 1=urgent, 2=high, 3=medium, 4=low.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          project_id: { type: "string", description: "UUID of the project, or omit for inbox" },
          parent_task_id: { type: "string", description: "UUID of parent task; makes this a subtask" },
          description: { type: "string" },
          priority: { type: "integer", minimum: 1, maximum: 4 },
          due_date: { type: "string", description: "ISO date or datetime" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description:
        "Update fields on an existing task. Pass only the fields you want to change. " +
        "Use status='done' to mark complete.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["todo", "in_progress", "done"] },
          priority: { type: "integer", minimum: 1, maximum: 4 },
          due_date: { type: "string" },
          project_id: { type: "string" },
          parent_task_id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description:
        "List tasks with optional filters. Returns up to 50 results, newest first.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          parent_task_id: { type: "string", description: "Pass to list subtasks of a specific task" },
          status: { type: "string", enum: ["todo", "in_progress", "done"] },
          due_before: { type: "string", description: "ISO date â€” return tasks due on or before this" },
          due_after: { type: "string", description: "ISO date â€” return tasks due on or after this" },
          inbox_only: { type: "boolean", description: "Only tasks with no project (inbox)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_task",
      description:
        "Find a task by title (fuzzy match). Use this when the user references a task by name " +
        "and you need its ID (e.g. before adding subtasks).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Create a new project (top-level container for tasks).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          color: { type: "string", description: "Hex like #3b82f6" },
          icon: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "List all projects. (Usually unnecessary â€” the system prompt already includes them.)",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a quick note. For longer/structured content (project plans), prefer create_page.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_page",
      description:
        "Create a structured page (Notion-style). Use for project plans, briefs, longer docs. " +
        "project_id attaches it to a project. parent_id nests it under another page.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string", description: "Markdown body" },
          parent_id: { type: "string" },
          project_id: { type: "string" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Full-text search across tasks, notes, and pages. Returns up to 20 hits.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["task", "note", "page"] },
            description: "Limit which types to search. Default: all.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_today",
      description: "Get today's date in ISO format. Useful when the user says 'today', 'tomorrow', etc.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool runner â€” single switch on tool name. Each branch returns a JSON-able
// object that gets passed back to the model as a tool result.
// ---------------------------------------------------------------------------
async function runTool(
  name: string,
  args: Record<string, unknown>,
  client: SupabaseClient,
  userId: string,
  touched: Set<string>,
): Promise<unknown> {
  switch (name) {
    case "create_task": {
      const { data, error } = await client
        .from("tasks")
        .insert({
          user_id: userId,
          title: args.title,
          project_id: args.project_id ?? null,
          parent_task_id: args.parent_task_id ?? null,
          description: args.description ?? null,
          priority: args.priority ?? 4,
          due_date: args.due_date ?? null,
          tags: args.tags ?? [],
        })
        .select("id, title, project_id, parent_task_id, due_date, priority, status")
        .single();
      if (error) return { ok: false, error: error.message };
      touched.add("tasks");
      return { ok: true, task: data };
    }

    case "update_task": {
      const { task_id, ...rest } = args as { task_id: string; [k: string]: unknown };
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      patch.updated_at = new Date().toISOString();
      if (rest.status === "done") patch.completed_at = new Date().toISOString();
      const { data, error } = await client
        .from("tasks")
        .update(patch)
        .eq("id", task_id)
        .select("id, title, status, priority, due_date, project_id, parent_task_id")
        .single();
      if (error) return { ok: false, error: error.message };
      touched.add("tasks");
      return { ok: true, task: data };
    }

    case "list_tasks": {
      let q = client
        .from("tasks")
        .select("id, title, status, priority, due_date, project_id, parent_task_id")
        .order("created_at", { ascending: false })
        .limit(50);
      if (args.project_id) q = q.eq("project_id", args.project_id);
      if (args.parent_task_id) q = q.eq("parent_task_id", args.parent_task_id);
      if (args.status) q = q.eq("status", args.status);
      if (args.due_before) q = q.lte("due_date", args.due_before);
      if (args.due_after) q = q.gte("due_date", args.due_after);
      if (args.inbox_only) q = q.is("project_id", null);
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      return { ok: true, tasks: data };
    }

    case "find_task": {
      const { data, error } = await client
        .from("tasks")
        .select("id, title, project_id, status")
        .ilike("title", `%${args.query}%`)
        .limit(10);
      if (error) return { ok: false, error: error.message };
      return { ok: true, matches: data };
    }

    case "create_project": {
      const { data, error } = await client
        .from("projects")
        .insert({
          user_id: userId,
          name: args.name,
          description: args.description ?? null,
          color: args.color ?? "#3b82f6",
          icon: args.icon ?? null,
        })
        .select("id, name, color")
        .single();
      if (error) return { ok: false, error: error.message };
      touched.add("projects");
      return { ok: true, project: data };
    }

    case "list_projects": {
      const { data, error } = await client
        .from("projects")
        .select("id, name, color, description")
        .order("position");
      if (error) return { ok: false, error: error.message };
      return { ok: true, projects: data };
    }

    case "create_note": {
      const { data, error } = await client
        .from("notes")
        .insert({
          user_id: userId,
          title: args.title ?? "Untitled",
          content: args.content,
          tags: args.tags ?? [],
        })
        .select("id, title")
        .single();
      if (error) return { ok: false, error: error.message };
      touched.add("notes");
      return { ok: true, note: data };
    }

    case "create_page": {
      const { data, error } = await client
        .from("pages")
        .insert({
          user_id: userId,
          title: args.title,
          content: args.content,
          parent_id: args.parent_id ?? null,
          project_id: args.project_id ?? null,
        })
        .select("id, title, project_id, parent_id")
        .single();
      if (error) return { ok: false, error: error.message };
      touched.add("pages");
      return { ok: true, page: data };
    }

    case "search": {
      const kinds = (args.kinds as string[] | undefined) ?? ["task", "note", "page"];
      const query = args.query as string;
      const out: Record<string, unknown> = {};
      if (kinds.includes("task")) {
        const { data } = await client
          .from("tasks")
          .select("id, title, status, project_id")
          .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
          .limit(10);
        out.tasks = data ?? [];
      }
      if (kinds.includes("note")) {
        const { data } = await client
          .from("notes")
          .select("id, title, tags")
          .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
          .limit(10);
        out.notes = data ?? [];
      }
      if (kinds.includes("page")) {
        const { data } = await client
          .from("pages")
          .select("id, title, project_id")
          .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
          .limit(10);
        out.pages = data ?? [];
      }
      return { ok: true, ...out };
    }

    case "get_today": {
      return { ok: true, date: new Date().toISOString().slice(0, 10) };
    }

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// System prompt builder.
// ---------------------------------------------------------------------------
function buildSystemPrompt(args: {
  today: string;
  projects: Array<{ id: string; name: string; description: string | null }>;
  override?: string;
}): string {
  if (args.override) return args.override;
  const projectList = args.projects.length
    ? args.projects
        .map((p) => `- ${p.name} (id: ${p.id})${p.description ? ` â€” ${p.description}` : ""}`)
        .join("\n")
    : "(none yet)";
  return `You are EagleVision, Jair's personal life-organization assistant.

Today is ${args.today}.

Jair's projects:
${projectList}

You can create and update tasks, notes, and project plans on his behalf using the
provided tools. When he names a project, find its id from the list above and pass
it directly â€” don't call list_projects unless the project clearly isn't there.

Conventions:
- This is a single-user app (just Jair). Be direct and concise. Skip greetings and
  filler. After taking action, confirm in one sentence what you did.
- Tasks have status (todo/in_progress/done) and priority (1=urgent .. 4=low).
  Default priority is 4 unless he indicates urgency.
- For project plans, longer briefs, or any structured doc, use create_page with
  project_id set. Use create_note only for quick captures.
- Subtasks: pass parent_task_id when adding child tasks. Use find_task first if
  you don't already know the parent's id.
- Date language: "today" = ${args.today}. "tomorrow" = the next calendar day.
  "next week" = the coming Monday. Always pass ISO dates to tools.
- Never ask "are you sure?" for create operations. Do ask before bulk delete or
  before overwriting an existing plan/note's content.
- If a tool returns an error, tell Jair plainly what went wrong and what you
  tried. Don't loop forever on the same failing call.`;
}

// ---------------------------------------------------------------------------
// Main handler.
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonError(401, "Missing Authorization header");
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return jsonError(500, "Supabase env not configured");
    if (!LOVABLE_API_KEY) return jsonError(500, "LOVABLE_API_KEY missing");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonError(401, "Invalid auth");
    const userId = userData.user.id;

    const body = await req.json();
    const messages: Array<{ role: string; content: string }> = body.messages ?? [];
    const model: string = body.model ?? DEFAULT_MODEL;
    const systemOverride: string | undefined = body.system;

    const { data: projects } = await userClient
      .from("projects")
      .select("id, name, description")
      .order("position");
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = buildSystemPrompt({
      today,
      projects: projects ?? [],
      override: systemOverride,
    });

    const history: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const touched = new Set<string>();

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const resp = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: history,
          tools: TOOLS,
          tool_choice: "auto",
          stream: false,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        if (resp.status === 429) return jsonError(429, "Rate limited");
        if (resp.status === 402) return jsonError(402, "AI credits exhausted");
        return jsonError(500, `Gateway error: ${text.slice(0, 500)}`);
      }

      const data = await resp.json();
      const choice = data.choices?.[0]?.message;
      if (!choice) return jsonError(500, "Gateway returned no choice");

      history.push(choice);

      if (!choice.tool_calls || choice.tool_calls.length === 0) {
        return new Response(
          JSON.stringify({
            reply: choice.content ?? "",
            touched: Array.from(touched),
            usage: data.usage ?? null,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      for (const tc of choice.tool_calls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          parsed = {};
        }
        const result = await runTool(tc.function.name, parsed, userClient, userId, touched);
        history.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    }

    return jsonError(500, "Tool loop exceeded max iterations");
  } catch (e) {
    return jsonError(500, e instanceof Error ? e.message : "Unknown error");
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
