import { useGetAgentStatus, useGetDashboardOverview, useListAgentRuns, getGetAgentStatusQueryKey, getGetDashboardOverviewQueryKey, getListAgentRunsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import {
  Search, BrainCircuit, ShieldCheck, Scale, Zap, RefreshCw,
  ArrowRight, CheckCircle2, AlertTriangle, XCircle, Clock, Activity
} from "lucide-react";
import { motion } from "framer-motion";

const API_BASE = `${import.meta.env.BASE_URL}api`;

function useCosts() {
  return useQuery({
    queryKey: ["/api/costs"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/costs`);
      return res.json();
    },
    refetchInterval: 10000,
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

export default function Brain() {
  const { data: agents } = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 3000 } });
  const { data: overview } = useGetDashboardOverview({ query: { queryKey: getGetDashboardOverviewQueryKey(), refetchInterval: 5000 } });
  const { data: runs } = useListAgentRuns({ limit: 20 }, { query: { queryKey: getListAgentRunsQueryKey({ limit: 20 }), refetchInterval: 3000 } });
  const { data: costs } = useCosts();

  const agentMap = new Map((agents || []).map(a => [a.name, a]));

  const statusIcon = (status: string) => {
    if (status === "running") return <span className="relative flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" /><span className="relative inline-flex rounded-full h-3 w-3 bg-primary" /></span>;
    if (status === "error") return <XCircle className="w-3.5 h-3.5 text-destructive" />;
    return <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />;
  };

  const currentAgent = agents?.find(a => a.status === "running");

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight">Decision Brain</h2>
            <p className="text-muted-foreground mt-1">Live view of the 6-agent orchestration pipeline.</p>
          </div>
          <div className="flex items-center gap-3">
            {overview?.pipelineActive ? (
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
          </div>
        </div>

        <div className="relative">
          <div className="flex items-stretch gap-2 overflow-x-auto pb-4">
            {AGENT_PIPELINE.map((agent, i) => {
              const liveAgent = agentMap.get(agent.name);
              const isRunning = liveAgent?.status === "running";
              const isError = liveAgent?.status === "error";
              const Icon = agent.icon;

              return (
                <motion.div
                  key={agent.name}
                  className="flex items-center gap-2 flex-shrink-0"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.08 }}
                >
                  <Card className={`w-44 glass-panel border-white/10 transition-all duration-500 ${isRunning ? "ring-2 ring-primary/50 shadow-lg shadow-primary/10" : isError ? "ring-1 ring-destructive/30" : ""}`}>
                    <CardContent className="p-4 flex flex-col items-center text-center gap-2">
                      <div className={`p-3 rounded-xl bg-gradient-to-br ${agent.bg} ${isRunning ? "animate-pulse" : ""}`}>
                        <Icon className={`w-6 h-6 ${agent.color}`} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">{agent.name}</div>
                        <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{agent.description}</div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        {statusIcon(liveAgent?.status || "idle")}
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${isRunning ? "text-primary" : isError ? "text-destructive" : "text-muted-foreground"}`}>
                          {liveAgent?.status || "idle"}
                        </span>
                      </div>
                      {liveAgent?.lastRunAt && (
                        <div className="text-[10px] text-muted-foreground/60">
                          {formatDistanceToNow(new Date(liveAgent.lastRunAt), { addSuffix: true })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  {i < AGENT_PIPELINE.length - 1 && (
                    <ArrowRight className="w-5 h-5 text-white/20 flex-shrink-0" />
                  )}
                </motion.div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
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
                          <td className="px-4 py-2.5 w-24 whitespace-nowrap text-[11px] font-mono text-muted-foreground/70">
                            {format(new Date(run.createdAt), "HH:mm:ss")}
                          </td>
                          <td className="px-4 py-2.5 w-32">
                            <span className="text-xs font-semibold text-white">{run.agentName}</span>
                          </td>
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
                          <td className="px-4 py-2.5 text-right text-[11px] font-mono text-muted-foreground/60 w-16">
                            {run.duration.toFixed(1)}s
                          </td>
                        </tr>
                      ))}
                      {!runs?.length && (
                        <tr>
                          <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                            No pipeline executions yet.
                          </td>
                        </tr>
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
                    <span className="text-sm font-semibold text-white">{currentAgent?.name || "None"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Last Cycle</span>
                    <span className="text-xs font-mono text-white">
                      {overview?.lastRunAt ? formatDistanceToNow(new Date(overview.lastRunAt), { addSuffix: true }) : "Never"}
                    </span>
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
                <CardTitle className="text-base">API Cost Tracker</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Today</span>
                  <span className="text-sm font-mono font-bold text-white">${costs?.daily?.costUsd?.toFixed(4) || "0.00"}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">This Month</span>
                  <span className="text-sm font-mono font-bold text-white">${costs?.monthly?.costUsd?.toFixed(4) || "0.00"}</span>
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
