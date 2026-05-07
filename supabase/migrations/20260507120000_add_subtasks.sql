-- =====================================================================
-- 20260507120000_add_subtasks.sql
-- Adds Jira/ClickUp-style subtask hierarchy, links pages to projects,
-- and adds fast full-text search on tasks/notes/pages.
-- Safe to run on the existing schema.
-- =====================================================================

-- 1. Subtasks: each task can optionally have a parent task.
alter table public.tasks
  add column if not exists parent_task_id uuid references public.tasks(id) on delete cascade;
create index if not exists tasks_parent_idx on public.tasks (parent_task_id);

-- 2. Tags on tasks (Jira-like labels).
alter table public.tasks
  add column if not exists tags text[] not null default '{}';
create index if not exists tasks_tags_idx on public.tasks using gin (tags);

-- 3. Pages can be attached to a project (this is where project plans live).
alter table public.pages
  add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists pages_project_idx on public.pages (user_id, project_id);

-- 4. Full-text search columns + GIN indexes.
--    Generated tsvectors stay in sync automatically.
alter table public.tasks
  add column if not exists search tsvector
  generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,''))
  ) stored;
create index if not exists tasks_search_idx on public.tasks using gin (search);

alter table public.notes
  add column if not exists search tsvector
  generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
  ) stored;
create index if not exists notes_search_idx on public.notes using gin (search);

alter table public.pages
  add column if not exists search tsvector
  generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
  ) stored;
create index if not exists pages_search_idx on public.pages using gin (search);

-- 5. Helpful: project descriptions (for the agent's system prompt).
alter table public.projects
  add column if not exists description text;
