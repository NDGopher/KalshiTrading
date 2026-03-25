import { useState, useEffect, useRef } from "react";
import { useGetAgentStatus, useGetDashboardOverview, useListAgentRuns, getGetAgentStatusQueryKey, getGetDashboardOverviewQueryKey, getListAgentRunsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import {
  Search, BrainCircuit, ShieldCheck, Scale, Zap, RefreshCw,
  ArrowRight, CheckCircle2, AlertTriangle, XCircle, Clock, Activity,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const API_BASE = `${import.meta.env.BASE_URL}api`;

function useCosts() {
  return useQuery({
    queryKey: ["/api/costs"],
    queryFn: async () => { const res = await fetch(`${API_BASE}/costs`); return res.json(); },
    refetchInterval: 10000,
  });
}

interface LastCycleMarket {
  ticker: string;
  title: string;
  sport: string;
  yesPrice: number;
  modelProbability: number;
  confidence: number;
  edge: number;
  kellyFraction: number | null;
  side: "yes" | "no";
  strategyName: string | null;
  reasoning: string | null;
  strategyReason: string | null;
  disposition: "executed" | "skipped_risk" | "skipped_audit" | "skipped_duplicate" | "skipped_confidence" | "skipped_no_price" | "candidate";
  rejectionReason: string | null;
}

interface LastCycleState {
  markets: LastCycleMarket[];
  cycleAt: string | null;
  activeAgent: string | null;
  cycleId: string | null;
  inProgress: boolean;
}

function useLastCycle() {
  return useQuery<LastCycleState>({
    queryKey: ["/api/agents/last-cycle"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/agents/last-cycle`);
      const data = await res.json();
      return { markets: data.markets ?? [], cycleAt: data.cycleAt ?? null, activeAgent: data.activeAgent ?? null, cycleId: data.cycleId ?? null, inProgress: data.inProgress ?? false };
    },
    refetchInterval: 3000,
  });
}

const AGENT_PIPELINE = [
  { name: "Scanner", icon: Search, description: "Finds candidate markets", color: "text-blue-400", bg: "from-blue-500/20 to-blue-600/10" },
  { name: "Analyst", icon: BrainCircuit, description: "Evaluates probabilities & edge", color: "text-purple-400", bg: "from-purple-500/20 to-purple-600/10" },
  { name: "Auditor", icon: ShieldCheck, description: "Filters by liquidity & thresholds", color: "text-cyan-400", bg: "from-cyan-500/20 to-cyan-600/10" },
  { name: "Risk Manager", icon: Scale, description: "Kelly sizing & exposure limits", color: "text-yellow-400", bg: "from-yellow-500/20 to-yellow-600/10" },
  { name: "Executor", icon: Zap, description: "Places trades on Kalshi", color: "text-green-400", bg: "from-green-500/20 to-green-600/10" },
  { name: "Reconciler", icon: RefreshCw, description: "Settles & tracks outcomes", color: "text-orange-400", bg: "from-orange-500/20 to-orange-600/10" },
];

function TypewriterText({ text, active, speed = 18 }: { text: string; active: boolean; speed?: number }) {
  const [displayed, setDisplayed] = useState(active ? "" : text);
  const posRef = useRef(active ? 0 : text.length);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) { setDisplayed(text); return; }
    posRef.current = 0;
    setDisplayed("");
    timerRef.current = setInterval(() => {
      posRef.current += 1;
      setDisplayed(text.slice(0, posRef.current));
      if (posRef.current >= text.length && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, speed);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [text, active, speed]);

  return (
    <span>
      {displayed}
      {active && displayed.length < text.length && (
        <span className="inline-block w-[6px] h-[11px] bg-primary/70 ml-[1px] animate-pulse align-middle" />
      )}
    </span>
  );
}

function DispositionBadge({ d }: { d: LastCycleMarket["disposition"] }) {
  if (d === "executed") return <Badge className="bg-success/20 text-success border-success/30 text-[10px]">EXECUTED</Badge>;
  if (d === "skipped_risk") return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px]">RISK BLOCKED</Badge>;
  if (d === "skipped_audit") return <Badge className="bg-destructive/20 text-destructive border-destructive/30 text-[10px]">FILTERED</Badge>;
  if (d === "skipped_confidence") return <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-[10px]">CONF CEILING</Badge>;
  if (d === "skipped_no_price") return <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[10px]">NO PRICE CAP</Badge>;
  if (d === "skipped_duplicate") return <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30 text-[10px]">DUPLICATE</Badge>;
  return <Badge variant="outline" className="text-muted-foreground text-[10px]">CANDIDATE</Badge>;
}

function MarketCard({ market, index, isLive }: { market: LastCycleMarket; index: number; isLive: boolean }) {
  const [reasoningExpanded, setReasoningExpanded] = useState(isLive);
  const glow = market.disposition === "executed"
    ? "ring-1 ring-success/30 shadow-lg shadow-success/5"
    : market.disposition === "skipped_risk"
    ? "ring-1 ring-yellow-500/20"
    : market.disposition === "skipped_audit"
    ? "opacity-60"
    : "";

  const modelPct = (market.modelProbability * 100).toFixed(1);
  const marketPct = (market.yesPrice * 100).toFixed(1);
  const edgePositive = market.edge > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.3 }}
    >
      <Card className={`glass-panel border-white/10 transition-all duration-300 ${glow} ${isLive ? "ring-1 ring-primary/20" : ""}`}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <div className="text-[11px] font-mono text-muted-foreground/70 truncate">{market.ticker}</div>
                {isLive && (
                  <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
                  </span>
                )}
              </div>
              <div className="text-xs font-semibold text-white truncate mt-0.5" title={market.title}>{market.title}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{market.sport}</div>
            </div>
            <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
              <DispositionBadge d={market.disposition} />
              <Badge variant={market.side === "yes" ? "success" : "destructive"} className="text-[10px]">
                {market.side.toUpperCase()}
              </Badge>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Market price</span>
              <span className="font-mono text-white">{marketPct}%</span>
            </div>
            <div className="relative h-1.5 bg-white/5 rounded-full overflow-hidden">
              <motion.div
                className="absolute h-full bg-white/20 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${market.yesPrice * 100}%` }}
                transition={{ duration: 0.6, delay: index * 0.05 }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Model probability</span>
              <span className={`font-mono font-semibold ${market.modelProbability > market.yesPrice ? "text-success" : "text-destructive"}`}>{modelPct}%</span>
            </div>
            <div className="relative h-1.5 bg-white/5 rounded-full overflow-hidden">
              <motion.div
                className={`absolute h-full rounded-full ${market.modelProbability > market.yesPrice ? "bg-success" : "bg-destructive"}`}
                initial={{ width: 0 }}
                animate={{ width: `${market.modelProbability * 100}%` }}
                transition={{ duration: 0.8, delay: index * 0.05 + 0.2 }}
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Confidence</span>
              <span className="font-mono font-semibold text-white">{(market.confidence * 100).toFixed(0)}%</span>
            </div>
            <div className="relative h-1.5 bg-white/5 rounded-full overflow-hidden">
              <motion.div
                className={`absolute h-full rounded-full ${market.confidence >= 0.7 ? "bg-primary" : market.confidence >= 0.5 ? "bg-yellow-400" : "bg-muted-foreground/40"}`}
                initial={{ width: 0 }}
                animate={{ width: `${market.confidence * 100}%` }}
                transition={{ duration: 0.7, delay: index * 0.05 + 0.4 }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground uppercase">Edge</div>
              <div className={`text-sm font-mono font-bold ${edgePositive ? "text-success" : "text-muted-foreground"}`}>
                {edgePositive ? "+" : ""}{market.edge.toFixed(1)}%
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground uppercase">Kelly</div>
              <div className="text-sm font-mono font-bold text-white">
                {market.kellyFraction != null ? `${(market.kellyFraction * 100).toFixed(1)}%` : "—"}
              </div>
            </div>
          </div>

          {market.strategyName && (
            <div className="flex items-center gap-1.5 text-[10px] text-primary/80 font-medium">
              <span>{market.strategyName}</span>
              {market.strategyReason && (
                <span className="text-muted-foreground/50 truncate max-w-[120px]" title={market.strategyReason}>— {market.strategyReason}</span>
              )}
            </div>
          )}

          {market.rejectionReason && (
            <div className="text-[10px] text-destructive/80 bg-destructive/5 rounded px-2 py-1 border border-destructive/10">
              ✕ {market.rejectionReason}
            </div>
          )}

          {market.reasoning && (
            <div>
              <button
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-1"
                onClick={() => setReasoningExpanded(e => !e)}
              >
                {reasoningExpanded ? "▲" : "▼"} {isLive ? "Live AI Reasoning" : "AI Reasoning"}
              </button>
              <AnimatePresence>
                {reasoningExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-1.5 text-[10px] text-muted-foreground/70 leading-relaxed bg-black/20 rounded p-2 border border-white/5 font-mono">
                      <TypewriterText text={market.reasoning} active={isLive} speed={12} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default function Brain() {
  const { data: agents } = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 3000 } });
  const { data: overview } = useGetDashboardOverview({ query: { queryKey: getGetDashboardOverviewQueryKey(), refetchInterval: 5000 } });
  const { data: runs } = useListAgentRuns({ limit: 20 }, { query: { queryKey: getListAgentRunsQueryKey({ limit: 20 }), refetchInterval: 3000 } });
  const { data: costs } = useCosts();
  const { data: lastCycle } = useLastCycle();

  const prevCycleIdRef = useRef<string | null>(null);
  const [liveTickerSet, setLiveTickerSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!lastCycle) return undefined;
    const newId = lastCycle.cycleId ?? lastCycle.cycleAt;
    if (newId && newId !== prevCycleIdRef.current) {
      prevCycleIdRef.current = newId;
      const newTickers = new Set<string>((lastCycle.markets || []).map((m: LastCycleMarket) => m.ticker));
      setLiveTickerSet(newTickers);
      const timer = setTimeout(() => setLiveTickerSet(new Set<string>()), 90000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [lastCycle]);

  const agentMap = new Map((agents || []).map(a => [a.name, a]));
  const currentAgent = agents?.find(a => a.status === "running");
  const cycleMarkets: LastCycleMarket[] = lastCycle?.markets || [];
  const executed = cycleMarkets.filter((m: LastCycleMarket) => m.disposition === "executed");
  const filtered = cycleMarkets.filter((m: LastCycleMarket) => m.disposition !== "executed");
  const isCycleLive = overview?.pipelineActive && lastCycle?.inProgress;

  const isLive = (ticker: string) => liveTickerSet.has(ticker);

  const statusIcon = (status: string) => {
    if (status === "running") return <span className="relative flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" /><span className="relative inline-flex rounded-full h-3 w-3 bg-primary" /></span>;
    if (status === "error") return <XCircle className="w-3.5 h-3.5 text-destructive" />;
    return <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />;
  };

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight">Decision Brain</h2>
            <p className="text-muted-foreground mt-1">Live view of the 6-agent orchestration pipeline.</p>
          </div>
          <div className="flex items-center gap-3">
            {isCycleLive ? (
              <Badge className="bg-primary/20 text-primary border-primary/30 gap-1.5 px-3 py-1 animate-pulse">
                <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-primary" /></span>
                Cycle In Progress
              </Badge>
            ) : overview?.pipelineActive ? (
              <Badge className="bg-success/20 text-success border-success/30 gap-1.5 px-3 py-1">
                <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-success" /></span>
                Pipeline Active
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 px-3 py-1 text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                Pipeline Halted
              </Badge>
            )}
            {lastCycle?.activeAgent && (
              <Badge variant="outline" className="text-xs text-primary border-primary/30 px-2 py-1">
                ▶ {lastCycle.activeAgent}
              </Badge>
            )}
          </div>
        </div>

        <div className="relative">
          <div className="flex items-stretch gap-2 overflow-x-auto pb-4">
            {AGENT_PIPELINE.map((agent, i) => {
              const liveAgent = agentMap.get(agent.name);
              const isRunning = liveAgent?.status === "running";
              const isError = liveAgent?.status === "error";
              const isActiveInCycle = lastCycle?.activeAgent === agent.name;
              const Icon = agent.icon;
              return (
                <motion.div key={agent.name} className="flex items-center gap-2 flex-shrink-0" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
                  <Card className={`w-44 glass-panel border-white/10 transition-all duration-500 ${isRunning || isActiveInCycle ? "ring-2 ring-primary/50 shadow-lg shadow-primary/10" : isError ? "ring-1 ring-destructive/30" : ""}`}>
                    <CardContent className="p-4 flex flex-col items-center text-center gap-2">
                      <div className={`p-3 rounded-xl bg-gradient-to-br ${agent.bg} ${isRunning || isActiveInCycle ? "animate-pulse" : ""}`}>
                        <Icon className={`w-6 h-6 ${agent.color}`} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">{agent.name}</div>
                        <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{agent.description}</div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        {statusIcon(liveAgent?.status || "idle")}
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${isRunning || isActiveInCycle ? "text-primary" : isError ? "text-destructive" : "text-muted-foreground"}`}>
                          {isActiveInCycle ? "active" : liveAgent?.status || "idle"}
                        </span>
                      </div>
                      {liveAgent?.lastRunAt && (
                        <div className="text-[10px] text-muted-foreground/60">{formatDistanceToNow(new Date(liveAgent.lastRunAt), { addSuffix: true })}</div>
                      )}
                    </CardContent>
                  </Card>
                  {i < AGENT_PIPELINE.length - 1 && <ArrowRight className={`w-5 h-5 flex-shrink-0 ${isActiveInCycle ? "text-primary/60" : "text-white/20"}`} />}
                </motion.div>
              );
            })}
          </div>
        </div>

        {cycleMarkets.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Activity className="w-5 h-5 text-primary" />
                  {isCycleLive ? "Live Cycle — Markets Streaming In" : "Last Cycle Markets"}
                  <Badge variant="outline" className="text-[10px] ml-1">{cycleMarkets.length} analyzed</Badge>
                  {isCycleLive && (
                    <span className="relative flex h-2 w-2 ml-1">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                    </span>
                  )}
                </h3>
                {lastCycle?.cycleAt && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {isCycleLive ? "Cycle running now" : `Cycle completed ${formatDistanceToNow(new Date(lastCycle.cycleAt), { addSuffix: true })}`}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-success" />{executed.length} executed</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-destructive" />{filtered.length} filtered</span>
              </div>
            </div>

            {executed.length > 0 && (
              <div>
                <div className="text-xs text-success/80 font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Executed Trades
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {executed.map((m, i) => <MarketCard key={m.ticker} market={m} index={i} isLive={isLive(m.ticker)} />)}
                </div>
              </div>
            )}

            {filtered.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground/60 font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <XCircle className="w-3.5 h-3.5" /> Evaluated but Not Traded
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {filtered.map((m, i) => <MarketCard key={m.ticker} market={m} index={i} isLive={isLive(m.ticker)} />)}
                </div>
              </div>
            )}
          </div>
        )}

        {cycleMarkets.length === 0 && (
          <Card className="glass-panel border-white/10">
            <CardContent className="p-12 text-center">
              <BrainCircuit className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">No cycle data yet. Trigger a pipeline run to see per-market analysis.</p>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="w-4 h-4 text-primary" />
                  Live Execution Log
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-[400px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-white/5">
                      {runs?.map((run) => (
                        <tr key={run.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-2.5 w-24 whitespace-nowrap text-[11px] font-mono text-muted-foreground/70">{format(new Date(run.createdAt), "HH:mm:ss")}</td>
                          <td className="px-4 py-2.5 w-32"><span className="text-xs font-semibold text-white">{run.agentName}</span></td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5">
                              {run.status === "success" && <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0" />}
                              {run.status === "error" && <AlertTriangle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />}
                              {run.status === "skipped" && <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                              <span className={`text-[11px] font-mono truncate ${run.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                                {run.details || `Completed in ${run.duration.toFixed(2)}s`}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-right text-[11px] font-mono text-muted-foreground/60 w-16">{run.duration.toFixed(1)}s</td>
                        </tr>
                      ))}
                      {!runs?.length && (
                        <tr><td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">No pipeline executions yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                <CardTitle className="text-base">Pipeline Stats</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Current Agent</span>
                    <span className="text-sm font-semibold text-white">{lastCycle?.activeAgent || currentAgent?.name || "None"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Last Cycle</span>
                    <span className="text-xs font-mono text-white">
                      {overview?.lastRunAt ? formatDistanceToNow(new Date(overview.lastRunAt), { addSuffix: true }) : "Never"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Cycle Status</span>
                    <Badge variant={isCycleLive ? "default" : "outline"} className={`text-[10px] ${isCycleLive ? "bg-primary/20 text-primary border-primary/30 animate-pulse" : "text-muted-foreground"}`}>
                      {isCycleLive ? "IN PROGRESS" : "IDLE"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Trading Mode</span>
                    <Badge variant={overview?.paperTradingMode ? "outline" : "default"} className={`text-[10px] ${overview?.paperTradingMode ? "text-yellow-400 border-yellow-500/30" : ""}`}>
                      {overview?.paperTradingMode ? "PAPER" : "LIVE"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Open Positions</span>
                    <span className="text-sm font-mono font-bold text-white">{overview?.openPositions ?? 0}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">API Cost Tracker</CardTitle>
                  {costs?.budgetPaused && <Badge variant="destructive" className="text-[10px]">BUDGET PAUSED</Badge>}
                </div>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                <div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Today</span>
                    <span className="text-sm font-mono font-bold text-white">
                      ${costs?.daily?.costUsd?.toFixed(4) || "0.00"}
                      {costs?.daily?.budgetUsd > 0 && <span className="text-muted-foreground/60 text-xs"> / ${costs.daily.budgetUsd}</span>}
                    </span>
                  </div>
                  {costs?.daily?.budgetUsd > 0 && (
                    <div className="w-full h-1.5 bg-white/5 rounded-full mt-1.5 overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${costs.daily.exceeded ? "bg-destructive" : "bg-primary"}`} style={{ width: `${Math.min(100, ((costs.daily.costUsd || 0) / costs.daily.budgetUsd) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">This Month</span>
                    <span className="text-sm font-mono font-bold text-white">
                      ${costs?.monthly?.costUsd?.toFixed(4) || "0.00"}
                      {costs?.monthly?.budgetUsd > 0 && <span className="text-muted-foreground/60 text-xs"> / ${costs.monthly.budgetUsd}</span>}
                    </span>
                  </div>
                  {costs?.monthly?.budgetUsd > 0 && (
                    <div className="w-full h-1.5 bg-white/5 rounded-full mt-1.5 overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${costs.monthly.exceeded ? "bg-destructive" : "bg-primary"}`} style={{ width: `${Math.min(100, ((costs.monthly.costUsd || 0) / costs.monthly.budgetUsd) * 100)}%` }} />
                    </div>
                  )}
                  {costs?.monthly?.projectedUsd > 0 && (
                    <div className="flex justify-between items-center mt-1.5">
                      <span className="text-[11px] text-muted-foreground">Projected EOM</span>
                      <span className={`text-xs font-mono ${costs.monthly.budgetUsd > 0 && costs.monthly.projectedUsd > costs.monthly.budgetUsd ? "text-destructive font-bold" : "text-muted-foreground"}`}>
                        ${costs.monthly.projectedUsd.toFixed(4)}
                      </span>
                    </div>
                  )}
                  {costs?.monthly?.budgetUsd > 0 && (
                    <div className="flex justify-between items-center mt-0.5">
                      <span className="text-[11px] text-muted-foreground">Remaining</span>
                      <span className="text-xs font-mono text-white">${Math.max(0, (costs.monthly.budgetUsd || 0) - (costs.monthly.costUsd || 0)).toFixed(4)}</span>
                    </div>
                  )}
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">All Time</span>
                  <span className="text-sm font-mono font-bold text-white">${costs?.allTime?.costUsd?.toFixed(4) || "0.00"}</span>
                </div>
                {costs?.byAgent && Array.isArray(costs.byAgent) && costs.byAgent.length > 0 && (
                  <div className="pt-2 border-t border-white/5 space-y-2">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">By Agent</div>
                    {(costs.byAgent as Array<{ agentName: string; costUsd: number; calls: number }>).map((agent) => (
                      <div key={agent.agentName} className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">{agent.agentName}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground/60">{agent.calls} calls</span>
                          <span className="text-xs font-mono text-white">${agent.costUsd.toFixed(4)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}
