import { useGetAgentStatus, useGetDashboardOverview, useListAgentRuns, useToggleAgentPipeline, useRunTradingCycle, getGetAgentStatusQueryKey, getGetDashboardOverviewQueryKey, getListAgentRunsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow, format } from "date-fns";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Cpu, Play, Power, AlertTriangle, CheckCircle2, Search, BrainCircuit, ShieldCheck, Scale, Zap, RefreshCw, GraduationCap, TrendingUp, TrendingDown, Minus, Sparkles } from "lucide-react";

interface LearningInsight {
  dimension: string;
  finding: string;
  action: string;
  signal: "favor" | "avoid" | "caution" | "neutral";
  trades: number;
  winRate: number;
  avgPnl: number;
}

interface LearningsData {
  latest: {
    createdAt: string;
    totalClosedTrades: number;
    winRate: number;
    totalPnl: number;
    insights: LearningInsight[];
    analystInjection: string;
  } | null;
  history: Array<{ createdAt: string; winRate: number; totalPnl: number; totalClosedTrades: number }>;
}

const BASE = import.meta.env.BASE_URL;

function useLearnings() {
  return useQuery<LearningsData>({
    queryKey: ["agent-learnings"],
    queryFn: async () => {
      const res = await fetch(`${BASE}api/agents/learnings`);
      if (!res.ok) throw new Error("Failed to fetch learnings");
      return res.json() as Promise<LearningsData>;
    },
    refetchInterval: 30000,
  });
}

function useRunLearner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}api/agents/learnings/run`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to run learner");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-learnings"] });
    },
  });
}

const signalColors: Record<string, string> = {
  favor: "text-green-400 border-green-400/30 bg-green-400/10",
  avoid: "text-red-400 border-red-400/30 bg-red-400/10",
  caution: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10",
  neutral: "text-slate-400 border-slate-400/30 bg-slate-400/10",
};

const signalIcons: Record<string, typeof TrendingUp> = {
  favor: TrendingUp,
  avoid: TrendingDown,
  caution: AlertTriangle,
  neutral: Minus,
};

export default function Agents() {
  const queryClient = useQueryClient();

  const { data: agents } = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 5000 } });
  const { data: runs } = useListAgentRuns({ limit: 20 }, { query: { queryKey: getListAgentRunsQueryKey({ limit: 20 }), refetchInterval: 5000 } });
  const { data: overview } = useGetDashboardOverview({ query: { queryKey: getGetDashboardOverviewQueryKey(), refetchInterval: 5000 } });
  const { data: learnings } = useLearnings();
  const runLearner = useRunLearner();

  const toggleMutation = useToggleAgentPipeline({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/dashboard/overview'] });
        queryClient.invalidateQueries({ queryKey: ['/api/agents/status'] });
      }
    }
  });

  const cycleMutation = useRunTradingCycle({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/agents/runs'] });
      }
    }
  });

  const agentIcons: Record<string, typeof Cpu> = {
    'Scanner': Search,
    'Analyst': BrainCircuit,
    'Auditor': ShieldCheck,
    'Risk Manager': Scale,
    'Executor': Zap,
    'Reconciler': RefreshCw,
    'Learner': GraduationCap,
  };

  const isPipelineActive = overview?.pipelineActive ?? false;
  const latest = learnings?.latest;

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">

        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight">Agent Network</h2>
            <p className="text-muted-foreground mt-1">7-agent pipeline with continuous self-learning from trade results.</p>
          </div>
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={handleCycle}
              disabled={cycleMutation.isPending}
              className="gap-2 bg-white/5 border-white/10 hover:bg-white/10"
            >
              {cycleMutation.isPending ? <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> : <Play className="w-4 h-4" />}
              Run Cycle
            </Button>
            <Button
              onClick={handleToggle}
              variant={isPipelineActive ? "destructive" : "default"}
              className="gap-2 shadow-lg"
            >
              <Power className="w-4 h-4" />
              {isPipelineActive ? "Halt Pipeline" : "Engage Pipeline"}
            </Button>
          </div>
        </div>

        {/* Agents Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {agents?.map((agent) => {
            const Icon = agentIcons[agent.name] || Cpu;
            const isRunning = agent.status === 'running';
            const isError = agent.status === 'error';

            return (
              <Card key={agent.name} className={`glass-panel border-t-4 transition-colors ${isRunning ? 'border-t-primary' : isError ? 'border-t-destructive' : agent.name === 'Learner' ? 'border-t-violet-500/60' : 'border-t-white/10'}`}>
                <CardContent className="p-5">
                  <div className="flex justify-between items-start mb-3">
                    <div className={`p-2.5 rounded-xl ${agent.name === 'Learner' ? 'bg-violet-500/10' : 'bg-white/5'} ${isRunning ? 'animate-pulse' : ''}`}>
                      <Icon className={`w-5 h-5 ${isRunning ? 'text-primary' : isError ? 'text-destructive' : agent.name === 'Learner' ? 'text-violet-400' : 'text-muted-foreground'}`} />
                    </div>
                    <Badge variant={isRunning ? 'default' : isError ? 'destructive' : 'secondary'} className={`text-[10px] ${isRunning ? 'animate-pulse' : ''}`}>
                      {agent.status.toUpperCase()}
                    </Badge>
                  </div>
                  <h3 className="text-sm font-semibold text-white mb-1">{agent.name}</h3>
                  <p className={`text-xs font-mono truncate ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {agent.errorMessage || agent.lastResult || '—'}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 mt-2">
                    {agent.lastRunAt ? formatDistanceToNow(new Date(agent.lastRunAt), { addSuffix: true }) : 'Never run'}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Learner Panel */}
        <Card className="glass-panel border-violet-500/20 bg-violet-950/10">
          <CardHeader className="border-b border-violet-500/10 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-violet-500/10">
                  <Sparkles className="w-5 h-5 text-violet-400" />
                </div>
                <div>
                  <CardTitle className="text-lg text-white flex items-center gap-2">
                    System Learnings
                    {latest && <span className="text-xs font-normal text-muted-foreground">from {latest.totalClosedTrades} closed trades</span>}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {latest
                      ? `Updated ${formatDistanceToNow(new Date(latest.createdAt), { addSuffix: true })} · ${Math.round(latest.winRate * 100)}% overall win rate · $${latest.totalPnl.toFixed(2)} net P&L`
                      : "No learnings generated yet — runs automatically every 10 pipeline cycles"}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => runLearner.mutate()}
                disabled={runLearner.isPending}
                className="gap-2 bg-violet-500/10 border-violet-500/30 hover:bg-violet-500/20 text-violet-300"
              >
                {runLearner.isPending
                  ? <span className="animate-spin w-3 h-3 border-2 border-violet-400/30 border-t-violet-400 rounded-full" />
                  : <GraduationCap className="w-3.5 h-3.5" />}
                Learn Now
              </Button>
            </div>
          </CardHeader>

          <CardContent className="p-6">
            {!latest ? (
              <div className="text-center py-10 text-muted-foreground">
                <GraduationCap className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No learnings yet. Click "Learn Now" to trigger the first analysis.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Insights grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {latest.insights.map((insight, i) => {
                    const Icon = signalIcons[insight.signal] ?? Minus;
                    const colorClass = signalColors[insight.signal] ?? signalColors.neutral;
                    return (
                      <div key={i} className={`rounded-xl border p-4 ${colorClass}`}>
                        <div className="flex items-start gap-3">
                          <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-xs font-mono font-bold">{insight.dimension}</span>
                              <span className="text-[10px] opacity-70">{insight.trades} trades · {Math.round(insight.winRate * 100)}% win · avg ${insight.avgPnl.toFixed(2)}</span>
                            </div>
                            <p className="text-xs text-white/90 mb-1.5">{insight.finding}</p>
                            <p className="text-[11px] opacity-80 font-mono">{insight.action}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Analyst injection preview */}
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs text-violet-400/70 hover:text-violet-400 select-none">
                    View analyst injection text (injected into every AI prompt)
                  </summary>
                  <pre className="mt-3 text-[11px] font-mono text-muted-foreground bg-black/30 rounded-lg p-4 whitespace-pre-wrap leading-relaxed border border-white/5">
                    {latest.analystInjection}
                  </pre>
                </details>
              </div>
            )}
          </CardContent>
        </Card>

        {/* System Logs */}
        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20">
            <CardTitle className="text-lg">System Logs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-hidden">
              <table className="w-full text-sm text-left">
                <tbody className="divide-y divide-white/5">
                  {runs?.map((run) => (
                    <tr key={run.id} className="hover:bg-white/[0.02]">
                      <td className="px-6 py-3 w-40 whitespace-nowrap text-xs font-mono text-muted-foreground">
                        {format(new Date(run.createdAt), "HH:mm:ss.SSS")}
                      </td>
                      <td className="px-6 py-3 w-48">
                        <span className={`font-semibold text-sm ${run.agentName === 'Learner' ? 'text-violet-400' : 'text-white'}`}>
                          {run.agentName}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          {run.status === 'success' && <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />}
                          {run.status === 'error' && <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />}
                          {run.status === 'skipped' && <div className="w-4 h-4 rounded-full border-2 border-muted-foreground flex-shrink-0" />}
                          <span className={`font-mono text-xs ${run.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {run.details || `Completed in ${run.duration.toFixed(2)}s`}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-3 text-right text-xs font-mono text-muted-foreground">
                        {run.duration.toFixed(2)}s
                      </td>
                    </tr>
                  ))}
                  {!runs?.length && (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                        No agent executions logged recently.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

      </div>
    </Layout>
  );

  function handleToggle() {
    toggleMutation.mutate({ data: { active: !isPipelineActive } });
  }

  function handleCycle() {
    cycleMutation.mutate();
  }
}
