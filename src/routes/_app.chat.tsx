import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Send, Sparkles, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/chat")({
  component: ChatPage,
  head: () => ({ meta: [{ title: "Chat â€” EagleVision" }] }),
});

type Msg = { id?: string; role: "user" | "assistant"; content: string };
type Conv = { id: string; title: string; model: string };

const MODELS = [
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
  { value: "openai/gpt-5", label: "GPT-5" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "openai/gpt-5.2", label: "GPT-5.2" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "google/gemini-3-flash-preview", label: "Gemini 3 Flash (no tools)" },
];

function ChatPage() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(MODELS[0].value);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    loadConvs();
  }, []);
  useEffect(() => {
    if (activeId) loadMessages(activeId);
    else setMessages([]);
  }, [activeId]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function loadConvs() {
    const { data } = await supabase
      .from("conversations")
      .select("id,title,model")
      .order("updated_at", { ascending: false });
    setConvs(data ?? []);
    if (data?.[0] && !activeId) setActiveId(data[0].id);
  }
  async function loadMessages(id: string) {
    const { data } = await supabase
      .from("messages")
      .select("id,role,content")
      .eq("conversation_id", id)
      .order("created_at");
    setMessages((data as Msg[]) ?? []);
    const conv = convs.find((c) => c.id === id);
    if (conv) setModel(conv.model);
  }
  async function newConv() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: u.user.id, title: "New chat", model })
      .select()
      .single();
    if (error) return toast.error(error.message);
    setConvs((c) => [data as Conv, ...c]);
    setActiveId(data.id);
    setMessages([]);
  }
  async function deleteConv(id: string) {
    await supabase.from("conversations").delete().eq("id", id);
    setConvs((c) => c.filter((x) => x.id !== id));
    if (activeId === id) setActiveId(null);
  }

  async function send() {
    if (!input.trim() || loading) return;
    const text = input.trim();
    setInput("");

    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;

    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      toast.error("Not signed in");
      return;
    }

    let convId = activeId;
    if (!convId) {
      const { data, error } = await supabase
        .from("conversations")
        .insert({ user_id: u.user.id, title: text.slice(0, 60), model })
        .select()
        .single();
      if (error) return toast.error(error.message);
      convId = data.id;
      setActiveId(convId);
      setConvs((c) => [data as Conv, ...c]);
    }

    const userMsg: Msg = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    await supabase.from("messages").insert({
      conversation_id: convId,
      user_id: u.user.id,
      role: "user",
      content: text,
    });

    setLoading(true);
    setMessages((m) => [...m, { role: "assistant", content: "â€¦" }]);

    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          model,
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!resp.ok) {
        if (resp.status === 429) toast.error("Rate limited, slow down.");
        else if (resp.status === 402) toast.error("AI credits exhausted.");
        else if (resp.status === 401) toast.error("Session expired â€” sign in again.");
        else toast.error("AI error");
        setMessages((m) => m.slice(0, -1));
        setLoading(false);
        return;
      }

      const data = await resp.json();
      const replyText: string = data.reply ?? "";
      const touched: string[] = data.touched ?? [];

      setMessages((m) =>
        m.map((msg, i) =>
          i === m.length - 1 && msg.role === "assistant"
            ? { ...msg, content: replyText }
            : msg,
        ),
      );

      await supabase.from("messages").insert({
        conversation_id: convId,
        user_id: u.user.id,
        role: "assistant",
        content: replyText,
      });

      for (const table of touched) {
        queryClient.invalidateQueries({ queryKey: [table] });
      }

      if (data.usage) {
        const provider = model.split("/")[0];
        await supabase.from("usage_log").insert({
          user_id: u.user.id,
          provider,
          model,
          prompt_tokens: data.usage.prompt_tokens ?? 0,
          completion_tokens: data.usage.completion_tokens ?? 0,
          cost_usd: 0,
        });
      }
    } catch (e) {
      toast.error("Network error");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/50 md:flex">
        <div className="p-3">
          <Button onClick={newConv} className="w-full justify-start gap-2" variant="outline">
            <Plus className="h-4 w-4" /> New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {convs.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                activeId === c.id && "bg-accent",
              )}
            >
              <button
                onClick={() => setActiveId(c.id)}
                className="flex-1 truncate text-left"
              >
                {c.title}
              </button>
              <button
                onClick={() => deleteConv(c.id)}
                className="opacity-0 transition group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <Sparkles className="h-6 w-6" />
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  How can I help you today?
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Ask anything. Pick a model above.
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "mb-6 flex gap-3",
                  m.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-card border border-border",
                  )}
                >
                  {m.role === "assistant" ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                      >
                        {m.content || "â€¦"}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-border bg-background p-4">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Message EagleVisionâ€¦"
              className="min-h-[52px] resize-none"
              rows={1}
            />
            <Button onClick={send} disabled={loading || !input.trim()} size="lg">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
