"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase/client";

type SessionItem = {
  key: string;
  sessionId: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  transcriptPath?: string;
  model?: string;
};

type SessionsListResult = {
  count: number;
  sessions: SessionItem[];
};

type TranscriptEvent = {
  ts?: number;
  kind: string;
  text?: string;
  tool?: string;
  raw: unknown;
};

const AGENT_NICKNAMES = ["Orbit", "Forge", "Pulse", "Scout", "Ledger"] as const;

// UI roster (what we show in the left rail), independent of which sessions are currently active.
const ROSTER = ["Amey", "OV Claw", ...AGENT_NICKNAMES] as const;

type LeadStage = "lead" | "qualified" | "meeting" | "proposal" | "won" | "lost";

type LeadItem = {
  id: string;
  name: string;
  company: string;
  role?: string;
  stage: LeadStage;
  value?: string;
  nextStep?: string;
  updatedAt: number;
};

type TaskStage = "inbox" | "assigned" | "in_progress" | "review" | "done";

type MissionStatus = 'INBOX' | 'ASSIGNED' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';

function taskStageToMissionStatus(stage: TaskStage): MissionStatus {
  switch (stage) {
    case 'inbox': return 'INBOX';
    case 'assigned': return 'ASSIGNED';
    case 'in_progress': return 'IN_PROGRESS';
    case 'review': return 'REVIEW';
    case 'done': return 'DONE';
  }
}

function missionStatusToTaskStage(status: MissionStatus): TaskStage {
  switch (status) {
    case 'INBOX': return 'inbox';
    case 'ASSIGNED': return 'assigned';
    case 'IN_PROGRESS': return 'in_progress';
    case 'REVIEW': return 'review';
    case 'DONE': return 'done';
  }
}

type TaskItem = {
  id: string;
  title: string;
  desc?: string;
  stage: TaskStage;
  tags?: string[];
  assignee?: string; // Orbit/Forge/Pulse/Scout/Ledger
  updatedAt: number;
};

const PIPELINE_STAGES: Array<{ key: LeadStage; label: string }> = [
  { key: "lead", label: "Lead" },
  { key: "qualified", label: "Qualified" },
  { key: "meeting", label: "Meeting" },
  { key: "proposal", label: "Proposal" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];

const TASK_STAGES: Array<{ key: TaskStage; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "assigned", label: "Assigned" },
  { key: "in_progress", label: "In progress" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

const TASK_STAGE_ACCENT: Record<TaskStage, string> = {
  inbox: "#94a3b8",
  assigned: "#f59e0b",
  in_progress: "#22c55e",
  review: "#a855f7",
  done: "#10b981",
};

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function fmtTs(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function fmtTimeNowIST(nowMs: number) {
  const d = new Date(nowMs);
  return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

function guessNickname(s: SessionItem): (typeof AGENT_NICKNAMES)[number] | null {
  const hay = `${s.displayName || ""} ${s.label || ""} ${s.sessionId || ""}`.toLowerCase();
  for (const n of AGENT_NICKNAMES) {
    if (hay.includes(n.toLowerCase())) return n;
  }
  return null;
}

function withNicknames(sessions: SessionItem[]): Array<SessionItem & { nickname: string }> {
  // Prefer explicit nicknames if the session label/displayName contains one (Orbit/Forge/Pulse/Scout/Ledger).
  // Fallback: assign by recency (most recently updated gets Orbit, next Forge, ...).
  const sorted = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const map = new Map<string, string>();

  // 1) Explicit
  for (const s of sessions) {
    const g = guessNickname(s);
    if (g) map.set(s.key, g);
  }

  // 2) Recency fill
  let i = 0;
  for (const s of sorted) {
    if (map.has(s.key)) continue;
    map.set(s.key, AGENT_NICKNAMES[i % AGENT_NICKNAMES.length]);
    i++;
  }

  return sessions.map((s) => ({ ...s, nickname: map.get(s.key) || "Agent" }));
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    border: "1px solid rgba(0,0,0,0.06)",
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
    background: active ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.7)",
  };
}

export default function DashboardClient() {
  const refreshMs = Number(process.env.NEXT_PUBLIC_REFRESH_MS || "2000");

  const [nowMs, setNowMs] = useState<number>(Date.now());

  const [sessions, setSessions] = useState<SessionsListResult | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string>("");
  const [statusError, setStatusError] = useState<string>("");
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [eventsError, setEventsError] = useState<string>("");

  const [feedFilter, setFeedFilter] = useState<"all" | "tools" | "messages" | "decisions" | "docs" | "status">("all");

  const [tab, setTab] = useState<"missions" | "pipeline">("missions");

  const [profileId, setProfileId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [dbError, setDbError] = useState<string>("" );

  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  const [newLead, setNewLead] = useState<{ name: string; company: string; role: string; value: string; nextStep: string }>(
    { name: "", company: "", role: "", value: "", nextStep: "" }
  );

  const [newTask, setNewTask] = useState<{ title: string; desc: string; assignee: string; tags: string }>(
    { title: "", desc: "", assignee: "", tags: "" }
  );

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Supabase auth/workspace bootstrap (pilot)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: u } = await supabase.auth.getUser();
        const uid = u.user?.id || null;
        if (!uid) return;
        if (cancelled) return;
        setProfileId(uid);
        const { data: prof, error } = await supabase.from('profiles').select('workspace_id').eq('id', uid).maybeSingle();
        if (error) throw error;
        const ws = (prof as { workspace_id?: string | null } | null)?.workspace_id || null;
        if (!ws) throw new Error('Workspace not found for user');
        if (cancelled) return;
        setWorkspaceId(ws);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Supabase bootstrap failed';
        setDbError(msg);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load/persist leads + tasks locally (v1)
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ov.pipeline.v1");
      if (raw) setLeads(JSON.parse(raw));
    } catch {
      // ignore
    }
    try {
      const raw = localStorage.getItem("ov.tasks.v1");
      if (raw) setTasks(JSON.parse(raw));
      else {
        // seed defaults once
        const seeded: TaskItem[] = [
          {
            id: uid(),
            title: "Draft Week 1 LinkedIn Posts (Luxury Residential)",
            desc: "3 posts + 1 carousel in Amey's voice; cinematic tone; CTA: Call +91 98674 09221",
            stage: "in_progress",
            assignee: "Forge",
            tags: ["linkedin", "content"],
            updatedAt: Date.now(),
          },
          {
            id: uid(),
            title: "Build Prospect List (Luxury Developers + Marketing Heads)",
            desc: "Mumbai + Pan-India; include named clients as proof; prep outreach sequences",
            stage: "assigned",
            assignee: "Scout",
            tags: ["outreach"],
            updatedAt: Date.now(),
          },
          {
            id: uid(),
            title: "Mission Control UI polish (reference screenshot)",
            desc: "Left Agents rail, center Kanban, right Live Feed, top stats bar, plus Sales pipeline",
            stage: "in_progress",
            assignee: "Orbit",
            tags: ["dashboard"],
            updatedAt: Date.now(),
          },
        ];
        setTasks(seeded);
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch missions from Supabase (overrides localStorage when available)
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('missions')
          .select('id,title,description,tags,status,assignee_profile_id,updated_at,created_at')
          .eq('workspace_id', workspaceId)
          .order('updated_at', { ascending: false });
        if (error) throw error;
        type MissionRow = {
          id: string;
          title: string;
          description: string | null;
          tags: string[] | null;
          status: MissionStatus;
          assignee_profile_id: string | null;
          updated_at: string | null;
          created_at: string | null;
        };

        const loaded: TaskItem[] = ((data || []) as MissionRow[]).map((m) => ({
          id: m.id,
          title: m.title,
          desc: m.description || '',
          stage: missionStatusToTaskStage(m.status),
          tags: m.tags || [],
          assignee: m.assignee_profile_id ? String(m.assignee_profile_id) : undefined,
          updatedAt: new Date(m.updated_at || m.created_at || Date.now()).getTime(),
        }));
        if (!cancelled) setTasks(loaded);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to load missions';
        setDbError(msg);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    try {
      localStorage.setItem("ov.pipeline.v1", JSON.stringify(leads));
    } catch {
      // ignore
    }
  }, [leads]);

  useEffect(() => {
    try {
      localStorage.setItem("ov.tasks.v1", JSON.stringify(tasks));
    } catch {
      // ignore
    }
  }, [tasks]);

  const sessionsWithNames = useMemo(() => {
    return sessions ? withNicknames(sessions.sessions) : [];
  }, [sessions]);

  const selected = useMemo(() => {
    return sessionsWithNames.find((s) => s.key === selectedKey) || null;
  }, [sessionsWithNames, selectedKey]);

  function isStatusKind(kind: string) {
    const k = kind.toLowerCase();
    return (
      k === "session" ||
      k === "status" ||
      k.endsWith("_change") ||
      k.startsWith("model_") ||
      k.startsWith("thinking_")
    );
  }

  function classifyEvent(ev: TranscriptEvent): "tools" | "messages" | "decisions" | "docs" | "status" | "other" {
    const kind = (ev.kind || "").toLowerCase();
    const hasTool = !!ev.tool;

    if (hasTool || kind === "tool" || kind === "tool_call") return "tools";
    if (kind === "message") return "messages";
    if (kind.includes("decision")) return "decisions";
    if (kind.includes("doc")) return "docs";
    if (isStatusKind(kind)) return "status";
    return "other";
  }

  const feedCounts = useMemo(() => {
    const counts = { all: 0, tools: 0, messages: 0, decisions: 0, docs: 0, status: 0 };
    counts.all = events.length;
    for (const ev of events) {
      const c = classifyEvent(ev);
      if (c === "tools") counts.tools++;
      else if (c === "messages") counts.messages++;
      else if (c === "decisions") counts.decisions++;
      else if (c === "docs") counts.docs++;
      else if (c === "status") counts.status++;
    }
    return counts;
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (feedFilter === "all") return events;
    return events.filter((ev) => classifyEvent(ev) === feedFilter);
  }, [events, feedFilter]);

  function fmtRelTime(ts?: number) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (!Number.isFinite(diff)) return "";
    const s = Math.max(0, Math.floor(diff / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function eventTitle(ev: TranscriptEvent) {
    const kind = (ev.kind || "").toLowerCase();
    if (kind === "message") return "Message";
    if (classifyEvent(ev) === "tools") return ev.tool ? `Tool · ${ev.tool}` : "Tool";
    if (kind.includes("decision")) return "Decision";
    if (kind.includes("doc")) return "Doc";
    if (isStatusKind(kind)) return kind.replaceAll("_", " ");
    return ev.kind || "Event";
  }

  function eventBody(ev: TranscriptEvent) {
    if (ev.text) return ev.text;
    const kind = (ev.kind || "").toLowerCase();
    if (kind === "message") return "(message)";
    if (isStatusKind(kind)) return "(status update)";
    return "(raw)";
  }

  // Fetch sessions
  useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        const r = await fetch("/api/oc/sessions", { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (j.ok) {
          setSessions(j.result as SessionsListResult);
          if (!selectedKey && j.result?.sessions?.[0]?.key) setSelectedKey(j.result.sessions[0].key);
        }
      } catch {
        // ignore
      }
    }

    tick();
    const id = setInterval(tick, refreshMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch status for selected agent
  useEffect(() => {
    if (!selectedKey) return;
    const key = selectedKey;
    let alive = true;

    async function tickStatus() {
      try {
        setStatusError("");
        const r = await fetch(`/api/oc/session-status?sessionKey=${encodeURIComponent(key)}`, {
          cache: "no-store",
        });
        const j = await r.json();
        if (!alive) return;
        if (j.ok) {
          const text =
            j.result?.details?.statusText ||
            j.result?.content?.[0]?.text ||
            JSON.stringify(j.result, null, 2);
          setStatusText(String(text));
        } else {
          setStatusText("");
          setStatusError(j.error || "Failed");
        }
      } catch (e) {
        if (!alive) return;
        setStatusText("");
        setStatusError(String(e));
      }
    }

    tickStatus();
    const id = setInterval(tickStatus, refreshMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selectedKey, refreshMs]);

  // Live Feed (pilot): mission events from Supabase
  useEffect(() => {
    if (!workspaceId) {
      setEvents([]);
      setEventsError("Waiting for workspace...");
      return;
    }

    let alive = true;

    function fmtMissionEvent(type: string, payload: unknown) {
      if (type === "MISSION_CREATED") return `Created mission: ${payload?.title || "(untitled)"}`;
      if (type === "STATUS_CHANGED") return `Status changed → ${payload?.status || "(unknown)"}`;
      return payload ? `${type}: ${JSON.stringify(payload)}` : type;
    }

    async function tickMissionEvents() {
      try {
        setEventsError("");
        const { data, error } = await supabase
          .from("events")
          .select("id,type,payload,created_at,mission_id")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(100);

        if (error) throw error;
        if (!alive) return;

        const mapped: TranscriptEvent[] = (data || []).map((row) => {
          const r = row as {
            created_at?: string | null;
            type?: string | null;
            payload?: unknown;
          };
          return {
            ts: r.created_at ? new Date(r.created_at).getTime() : undefined,
            kind: String(r.type || "event"),
            text: fmtMissionEvent(String(r.type || "event"), r.payload),
            raw: row,
          };
        });

        setEvents(mapped);
      } catch (e) {
        if (!alive) return;
        setEvents([]);
        setEventsError(e instanceof Error ? e.message : String(e));
      }
    }

    tickMissionEvents();
    const id = setInterval(tickMissionEvents, Math.max(2000, refreshMs));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [workspaceId, refreshMs]);

  const kpi = useMemo(() => {
    const agentCount = ROSTER.length;
    const activeAgents = sessionsWithNames.length;
    const tasksInQueue = tasks.filter((t) => t.stage !== "done").length;
    const leadsTotal = leads.length;

    const byLead = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, 0])) as Record<LeadStage, number>;
    for (const l of leads) byLead[l.stage] = (byLead[l.stage] || 0) + 1;

    const byTask = Object.fromEntries(TASK_STAGES.map((s) => [s.key, 0])) as Record<TaskStage, number>;
    for (const t of tasks) byTask[t.stage] = (byTask[t.stage] || 0) + 1;

    return { agentCount, activeAgents, tasksInQueue, leadsTotal, byLead, byTask };
  }, [sessionsWithNames.length, tasks, leads]);

  async function moveTask(id: string, stage: TaskStage) {
    // Optimistic UI
    const prevTasks = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, stage, updatedAt: Date.now() } : t)));

    if (!workspaceId) return;

    try {
      const status = taskStageToMissionStatus(stage);
      const { error } = await supabase.from("missions").update({ status }).eq("id", id);
      if (error) throw error;

      // Audit event
      await supabase.from("events").insert({
        workspace_id: workspaceId,
        type: "STATUS_CHANGED",
        mission_id: id,
        actor_profile_id: profileId,
        payload: { status },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update mission";
      setDbError(msg);
      // revert
      setTasks(prevTasks);
    }
  }

  function moveLead(id: string, stage: LeadStage) {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, stage, updatedAt: Date.now() } : l)));
  }

  function addLead() {
    const name = newLead.name.trim();
    const company = newLead.company.trim();
    if (!name || !company) return;
    setLeads((prev) => [
      {
        id: uid(),
        name,
        company,
        role: newLead.role.trim() || undefined,
        stage: "lead",
        value: newLead.value.trim() || undefined,
        nextStep: newLead.nextStep.trim() || undefined,
        updatedAt: Date.now(),
      },
      ...prev,
    ]);
    setNewLead({ name: "", company: "", role: "", value: "", nextStep: "" });
  }

  async function addTask() {
    const title = newTask.title.trim();
    if (!title) return;

    const tags = newTask.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // If Supabase is ready, persist; else fallback to local-only.
    if (workspaceId && profileId) {
      try {
        const { data, error } = await supabase
          .from("missions")
          .insert({
            workspace_id: workspaceId,
            title,
            description: newTask.desc.trim() || null,
            tags,
            status: "INBOX",
            created_by: profileId,
          })
          .select("id,title,description,tags,status,updated_at,created_at")
          .single();

        if (error) throw error;

        setTasks((prev) => [
          {
            id: data.id,
            title: data.title,
            desc: data.description || undefined,
            stage: "inbox",
            assignee: newTask.assignee.trim() || undefined,
            tags: (data.tags || undefined) as string[] | undefined,
            updatedAt: new Date(data.updated_at || data.created_at || Date.now()).getTime(),
          },
          ...prev,
        ]);

        await supabase.from("events").insert({
          workspace_id: workspaceId,
          type: "MISSION_CREATED",
          mission_id: data.id,
          actor_profile_id: profileId,
          payload: { title },
        });

        setNewTask({ title: "", desc: "", assignee: "", tags: "" });
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to add mission";
        setDbError(msg);
      }
    }

    setTasks((prev) => [
      {
        id: uid(),
        title,
        desc: newTask.desc.trim() || undefined,
        stage: "inbox",
        assignee: newTask.assignee.trim() || undefined,
        tags: tags.length ? tags : undefined,
        updatedAt: Date.now(),
      },
      ...prev,
    ]);
    setNewTask({ title: "", desc: "", assignee: "", tags: "" });
  }

  const page: React.CSSProperties = {
    padding: 12,
    maxWidth: 1480,
    margin: "0 auto",
  };

  const chrome: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 18,
    background: "rgba(255,255,255,0.75)",
    boxShadow: "0 12px 60px rgba(0,0,0,0.08)",
    overflow: "hidden",
  };

  const topbar: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    background: "rgba(255,255,255,0.65)",
    position: "sticky",
    top: 10,
    zIndex: 50,
    backdropFilter: "blur(10px)",
  };

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "270px 1fr 380px",
    gap: 0,
    minHeight: "calc(100vh - 140px)",
  };

  const rail: React.CSSProperties = {
    borderRight: "1px solid rgba(0,0,0,0.06)",
    padding: 10,
  };

  const rightRail: React.CSSProperties = {
    borderLeft: "1px solid rgba(0,0,0,0.06)",
    padding: 10,
  };

  const center: React.CSSProperties = {
    padding: 10,
  };

  return (
    <div style={page}>
      <div style={chrome}>
        <div style={topbar}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.7 }}>MISSION CONTROL</div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>Orange Videos</div>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.2 }}>{kpi.activeAgents}</div>
              <div style={{ fontSize: 10, opacity: 0.65, letterSpacing: 0.6 }}>agents active</div>
            </div>
            <div style={{ width: 1, height: 26, background: "rgba(0,0,0,0.08)" }} />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.2 }}>{kpi.agentCount}</div>
              <div style={{ fontSize: 10, opacity: 0.65, letterSpacing: 0.6 }}>roster</div>
            </div>
            <div style={{ width: 1, height: 26, background: "rgba(0,0,0,0.08)" }} />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.2 }}>{kpi.tasksInQueue}</div>
              <div style={{ fontSize: 10, opacity: 0.65, letterSpacing: 0.6 }}>tasks in queue</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button style={{ ...pillStyle(false), opacity: 0.85 }}>Docs</button>
            <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, opacity: 0.7 }}>
              {fmtTimeNowIST(nowMs)} IST
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                border: "1px solid rgba(0,0,0,0.06)",
                borderRadius: 999,
                padding: "6px 10px",
                background: "rgba(255,255,255,0.7)",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 99, background: "#22c55e", display: "inline-block" }} />
              <span style={{ fontSize: 12, opacity: 0.75, letterSpacing: 0.6 }}>ONLINE</span>
            </div>
          </div>
        </div>

        <div style={grid}>
          {/* Left agents */}
          <aside style={rail}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 1.1, opacity: 0.85 }}>AGENTS</div>
              <div style={{ fontSize: 11, opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>{ROSTER.length}</div>
            </div>

            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {ROSTER.map((name) => {
                const sess = sessionsWithNames.find((s) => s.nickname === name) || null;
                const active = !!sess && sess.key === selectedKey;
                const clickable = !!sess;

                const roleLabel = name === "Amey" ? "OWNER" : name === "OV Claw" ? "COORD" : "AGENT";
                const roleSub = name === "Amey" ? "Founder" : name === "OV Claw" ? "Mission Control" : sess?.label || "Specialist";

                return (
                  <button
                    key={name}
                    onClick={() => {
                      if (sess) setSelectedKey(sess.key);
                    }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "32px 1fr",
                      gap: 10,
                      textAlign: "left",
                      padding: "10px 10px",
                      borderRadius: 14,
                      border: active ? "1px solid rgba(0,0,0,0.16)" : "1px solid rgba(0,0,0,0.08)",
                      background: active ? "rgba(0,0,0,0.045)" : "rgba(255,255,255,0.70)",
                      cursor: clickable ? "pointer" : "default",
                      opacity: clickable ? 1 : 0.72,
                      boxShadow: active ? "0 10px 22px rgba(0,0,0,0.08)" : "none",
                    }}
                    title={clickable ? "Select" : "No active session"}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "linear-gradient(180deg, rgba(255,255,255,0.95), rgba(255,255,255,0.75))",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 12,
                        fontWeight: 800,
                        letterSpacing: 0.6,
                        color: "rgba(0,0,0,0.75)",
                        position: "relative",
                      }}
                    >
                      {name.slice(0, 1)}
                      <span
                        style={{
                          position: "absolute",
                          right: -2,
                          bottom: -2,
                          width: 10,
                          height: 10,
                          borderRadius: 99,
                          border: "2px solid rgba(255,255,255,0.95)",
                          background: sess ? "#22c55e" : "#94a3b8",
                          boxShadow: "0 0 0 1px rgba(0,0,0,0.10)",
                        }}
                        title={sess ? "Online" : "Offline"}
                      />
                    </div>

                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {name}
                          </div>
                          <span
                            style={{
                              fontSize: 10,
                              padding: "3px 7px",
                              borderRadius: 999,
                              border: "1px solid rgba(0,0,0,0.10)",
                              background: "rgba(0,0,0,0.03)",
                              letterSpacing: 0.9,
                              opacity: 0.8,
                              flex: "0 0 auto",
                            }}
                          >
                            {roleLabel}
                          </span>
                        </div>
                        <div style={{ fontSize: 10, opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
                          {sess?.updatedAt ? fmtRelTime(sess.updatedAt) : ""}
                        </div>
                      </div>

                      <div style={{ fontSize: 12, opacity: 0.72, marginTop: 2, lineHeight: 1.25 }}>
                        {roleSub}
                      </div>

                      <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "4px 8px",
                            borderRadius: 999,
                            border: "1px solid rgba(0,0,0,0.10)",
                            background: sess ? "rgba(34,197,94,0.10)" : "rgba(148,163,184,0.14)",
                            color: sess ? "#14532d" : "#475569",
                            letterSpacing: 0.8,
                            fontWeight: 800,
                          }}
                        >
                          {sess ? "WORKING" : "OFFLINE"}
                        </span>
                        {sess?.model ? (
                          <span style={{ fontSize: 10, opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>{sess.model}</span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.8 }}>CTA</div>
              <a
                href="tel:+919867409221"
                style={{
                  display: "block",
                  marginTop: 8,
                  padding: 10,
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.08)",
                  background: "rgba(255,255,255,0.75)",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Call +91 98674 09221
              </a>
            </div>
          </aside>

          {/* Center */}
          <main style={center}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 1.1, opacity: 0.85 }}>
                  {tab === "missions" ? "MISSION QUEUE" : "SALES PIPELINE"}
                </div>
                <div style={{ fontSize: 11, opacity: 0.62, marginTop: 4, lineHeight: 1.2 }}>
                  Luxury residential lead gen · Founder POV: Amey · Cinematic tone
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button style={pillStyle(tab === "missions")} onClick={() => setTab("missions")}>
                  Missions
                </button>
                <button style={pillStyle(tab === "pipeline")} onClick={() => setTab("pipeline")}>
                  Pipeline
                </button>
                <select
                  value={selectedKey || ""}
                  onChange={(e) => setSelectedKey(e.target.value)}
                  style={{ padding: 8, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                >
                  {sessionsWithNames.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.nickname}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {tab === "missions" ? (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gap: 8,
                    marginTop: 10,
                  }}
                >
                  <input
                    placeholder="New mission title"
                    value={newTask.title}
                    onChange={(e) => setNewTask((p) => ({ ...p, title: e.target.value }))}
                    style={{ padding: 10, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <input
                    placeholder="Assignee (Orbit/Forge/Pulse/Scout/Ledger)"
                    value={newTask.assignee}
                    onChange={(e) => setNewTask((p) => ({ ...p, assignee: e.target.value }))}
                    style={{ padding: 10, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <input
                    placeholder="Tags (comma separated)"
                    value={newTask.tags}
                    onChange={(e) => setNewTask((p) => ({ ...p, tags: e.target.value }))}
                    style={{ padding: 10, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <button
                    onClick={addTask}
                    style={{
                      padding: 10,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.08)",
                      background: "rgba(0,0,0,0.04)",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    Add mission
                  </button>
                </div>
                <textarea
                  placeholder="(optional) description"
                  value={newTask.desc}
                  onChange={(e) => setNewTask((p) => ({ ...p, desc: e.target.value }))}
                  style={{
                    marginTop: 8,
                    width: "100%",
                    padding: 10,
                    borderRadius: 12,
                    minHeight: 60,
                    border: "1px solid rgba(0,0,0,0.08)",
                  }}
                />

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                    gap: 8,
                    marginTop: 14,
                    alignItems: "start",
                  }}
                >
                  {TASK_STAGES.map((stage) => (
                    <div
                      key={stage.key}
                      style={{
                        border: "1px solid rgba(0,0,0,0.08)",
                        borderRadius: 14,
                        padding: 8,
                        background: "rgba(255,255,255,0.70)",
                        minHeight: 520,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "2px 2px 6px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: 99,
                              background: TASK_STAGE_ACCENT[stage.key],
                              display: "inline-block",
                              opacity: 0.9,
                              boxShadow: "0 0 0 1px rgba(0,0,0,0.06)",
                            }}
                          />
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 900,
                              letterSpacing: 0.8,
                              textTransform: "uppercase",
                              opacity: 0.9,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {stage.label}
                          </div>
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            opacity: 0.75,
                            fontVariantNumeric: "tabular-nums",
                            padding: "3px 8px",
                            borderRadius: 999,
                            border: "1px solid rgba(0,0,0,0.08)",
                            background: "rgba(255,255,255,0.75)",
                          }}
                        >
                          {kpi.byTask[stage.key] || 0}
                        </div>
                      </div>
                      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                        {tasks.filter((t) => t.stage === stage.key).length === 0 ? (
                          <div
                            style={{
                              fontSize: 12,
                              opacity: 0.55,
                              padding: 10,
                              borderRadius: 14,
                              border: "1px dashed rgba(0,0,0,0.10)",
                              background: "rgba(255,255,255,0.55)",
                            }}
                          >
                            No missions
                          </div>
                        ) : null}
                        {tasks
                          .filter((t) => t.stage === stage.key)
                          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                          .map((t) => (
                            <div
                              key={t.id}
                              style={{
                                border: "1px solid rgba(0,0,0,0.08)",
                                borderLeft: `4px solid ${TASK_STAGE_ACCENT[t.stage]}`,
                                borderRadius: 14,
                                padding: "9px 9px 8px",
                                background: "rgba(255,255,255,0.92)",
                                boxShadow: "0 10px 20px rgba(0,0,0,0.06)",
                              }}
                            >
                              <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 0.2, lineHeight: 1.25 }}>
                                {t.title}
                              </div>
                              {t.desc ? (
                                <div style={{ marginTop: 6, fontSize: 11, opacity: 0.74, lineHeight: 1.35 }}>
                                  {t.desc}
                                </div>
                              ) : null}
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                                {t.assignee ? (
                                  <span
                                    style={{
                                      fontSize: 11,
                                      padding: "4px 8px",
                                      borderRadius: 999,
                                      border: "1px solid rgba(0,0,0,0.08)",
                                      background: "rgba(0,0,0,0.03)",
                                    }}
                                  >
                                    {t.assignee}
                                  </span>
                                ) : null}
                                {(t.tags || []).map((tag) => (
                                  <span
                                    key={tag}
                                    style={{
                                      fontSize: 11,
                                      padding: "4px 8px",
                                      borderRadius: 999,
                                      border: "1px solid rgba(0,0,0,0.08)",
                                      background: "rgba(245,158,11,0.08)",
                                      color: "#92400e",
                                    }}
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                                {TASK_STAGES.filter((s) => s.key !== t.stage).map((s) => (
                                  <button
                                    key={s.key}
                                    onClick={() => moveTask(t.id, s.key)}
                                    style={{
                                      fontSize: 10,
                                      padding: "6px 8px",
                                      borderRadius: 999,
                                      border: "1px solid rgba(0,0,0,0.08)",
                                      background: "rgba(255,255,255,0.92)",
                                      cursor: "pointer",
                                      opacity: 0.92,
                                    }}
                                    title={`Move to ${s.label}`}
                                  >
                                    {s.label}
                                  </button>
                                ))}
                              </div>
                              <div style={{ fontSize: 10, opacity: 0.6, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>
                                {fmtRelTime(t.updatedAt) || fmtTs(t.updatedAt)}
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                    gap: 10,
                    marginTop: 12,
                  }}
                >
                  <input
                    placeholder="Name"
                    value={newLead.name}
                    onChange={(e) => setNewLead((p) => ({ ...p, name: e.target.value }))}
                    style={{ padding: 10, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <input
                    placeholder="Company"
                    value={newLead.company}
                    onChange={(e) => setNewLead((p) => ({ ...p, company: e.target.value }))}
                    style={{ padding: 10, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <input
                    placeholder="Role"
                    value={newLead.role}
                    onChange={(e) => setNewLead((p) => ({ ...p, role: e.target.value }))}
                    style={{ padding: 10, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <input
                    placeholder="Value"
                    value={newLead.value}
                    onChange={(e) => setNewLead((p) => ({ ...p, value: e.target.value }))}
                    style={{ padding: 10, borderRadius: 12, border: "1px solid rgba(0,0,0,0.08)" }}
                  />
                  <div style={{ display: "flex", gap: 10 }}>
                    <input
                      placeholder="Next step"
                      value={newLead.nextStep}
                      onChange={(e) => setNewLead((p) => ({ ...p, nextStep: e.target.value }))}
                      style={{
                        padding: 10,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.08)",
                        flex: 1,
                      }}
                    />
                    <button
                      onClick={addLead}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.08)",
                        background: "rgba(0,0,0,0.04)",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Add
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
                    gap: 10,
                    marginTop: 14,
                    alignItems: "start",
                  }}
                >
                  {PIPELINE_STAGES.map((stage) => (
                    <div
                      key={stage.key}
                      style={{
                        border: "1px solid rgba(0,0,0,0.08)",
                        borderRadius: 16,
                        padding: 10,
                        background: "rgba(255,255,255,0.75)",
                        minHeight: 420,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <div style={{ fontSize: 12, fontWeight: 800 }}>{stage.label}</div>
                        <div style={{ fontSize: 12, opacity: 0.6 }}>{kpi.byLead[stage.key] || 0}</div>
                      </div>
                      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                        {leads.filter((l) => l.stage === stage.key).length === 0 ? (
                          <div
                            style={{
                              fontSize: 12,
                              opacity: 0.55,
                              padding: 10,
                              borderRadius: 14,
                              border: "1px dashed rgba(0,0,0,0.10)",
                              background: "rgba(255,255,255,0.55)",
                            }}
                          >
                            No leads
                          </div>
                        ) : null}
                        {leads
                          .filter((l) => l.stage === stage.key)
                          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                          .map((l) => (
                            <div
                              key={l.id}
                              style={{
                                border: "1px solid rgba(0,0,0,0.08)",
                                borderRadius: 16,
                                padding: 10,
                                background: "rgba(255,255,255,0.95)",
                              }}
                            >
                              <div style={{ fontSize: 13, fontWeight: 800 }}>{l.company}</div>
                              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                                {l.name}
                                {l.role ? ` · ${l.role}` : ""}
                              </div>
                              {l.nextStep ? (
                                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>Next: {l.nextStep}</div>
                              ) : null}
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                                {PIPELINE_STAGES.filter((s) => s.key !== l.stage).map((s) => (
                                  <button
                                    key={s.key}
                                    onClick={() => moveLead(l.id, s.key)}
                                    style={{
                                      fontSize: 11,
                                      padding: "6px 8px",
                                      borderRadius: 999,
                                      border: "1px solid rgba(0,0,0,0.08)",
                                      background: "rgba(255,255,255,0.9)",
                                      cursor: "pointer",
                                      opacity: 0.9,
                                    }}
                                    title={`Move to ${s.label}`}
                                  >
                                    {s.label}
                                  </button>
                                ))}
                              </div>
                              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>updated {fmtTs(l.updatedAt)}</div>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </main>

          {/* Right rail (live feed + agent status) */}
          <aside style={rightRail}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.8 }}>LIVE FEED</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{filteredEvents.length} events</div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <button style={pillStyle(feedFilter === "all")} onClick={() => setFeedFilter("all")}>
                All&nbsp;{feedCounts.all}
              </button>
              <button style={pillStyle(feedFilter === "tools")} onClick={() => setFeedFilter("tools")}>
                Tasks&nbsp;{feedCounts.tools}
              </button>
              <button style={pillStyle(feedFilter === "messages")} onClick={() => setFeedFilter("messages")}>
                Comments&nbsp;{feedCounts.messages}
              </button>
              <button style={pillStyle(feedFilter === "decisions")} onClick={() => setFeedFilter("decisions")}>
                Decisions&nbsp;{feedCounts.decisions}
              </button>
              <button style={pillStyle(feedFilter === "docs")} onClick={() => setFeedFilter("docs")}>
                Docs&nbsp;{feedCounts.docs}
              </button>
              <button style={pillStyle(feedFilter === "status")} onClick={() => setFeedFilter("status")}>
                Status&nbsp;{feedCounts.status}
              </button>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <span style={{ ...pillStyle(false), cursor: "default", opacity: 0.7 }}>All Agents</span>
              {sessionsWithNames.slice(0, 12).map((s) => {
                const active = s.key === selectedKey;
                return (
                  <button
                    key={s.key}
                    style={pillStyle(active)}
                    onClick={() => setSelectedKey(s.key)}
                    title="Switch agent"
                  >
                    {s.nickname}
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10, maxHeight: 560, overflow: "auto", paddingRight: 6 }}>
              {eventsError ? (
                <div style={{ fontSize: 12, color: "#b91c1c" }}>{eventsError}</div>
              ) : (
                filteredEvents.slice(0, 25).map((ev, idx) => (
                  <div
                    key={idx}
                    style={{
                      border: "1px solid rgba(0,0,0,0.08)",
                      borderRadius: 16,
                      padding: 10,
                      background: "rgba(255,255,255,0.85)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.85 }}>{eventTitle(ev)}</div>
                      <div style={{ fontSize: 11, opacity: 0.6 }}>{fmtRelTime(ev.ts) || fmtTs(ev.ts)}</div>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.4, whiteSpace: "pre-wrap" }}>
                      {eventBody(ev).slice(0, 220)}
                      {eventBody(ev).length > 220 ? "…" : ""}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.8 }}>AGENT STATUS</div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Selected: {selected?.nickname || "—"}</div>
              {statusError ? (
                <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 11, color: "#b91c1c" }}>{statusError}</pre>
              ) : (
                <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.85 }}>{statusText}</pre>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
