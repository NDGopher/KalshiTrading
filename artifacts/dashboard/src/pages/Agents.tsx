import { useGetAgentStatus, useListAgentRuns, useToggleAgentPipeline, useRunTradingCycle } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow, format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { Cpu, Play, Power, AlertTriangle, CheckCircle2, Search, BrainCircuit, ShieldCheck, Scale, Zap } from "lucide-react";

export default function Agents() {
  const queryClient = useQueryClient();
  
  const { data: agents } = useGetAgentStatus({ query: { refetchInterval: 5000 } as object });
  const { data: runs } = useListAgentRuns({ limit: 10 }, { query: { refetchInterval: 5000 } as object });
  
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
  };

  const isPipelineActive = agents?.some(a => a.status !== 'disabled') ?? false;

  const handleToggle = () => {
    toggleMutation.mutate({ data: { active: !isPipelineActive } });
  };

  const handleCycle = () => {
    cycleMutation.mutate();
  };

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
        
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight">Agent Network</h2>
            <p className="text-muted-foreground mt-1">Monitor the 5-agent orchestration pipeline running 24/7.</p>
          </div>
          <div className="flex gap-3">
            <Button 
              variant="outline" 
              onClick={handleCycle}
              disabled={cycleMutation.isPending}
              className="gap-2 bg-white/5 border-white/10 hover:bg-white/10"
            >
              {cycleMutation.isPending ? <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> : <Play className="w-4 h-4" />}
              Run Single Cycle
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents?.map((agent) => {
            const Icon = agentIcons[agent.name] || Cpu;
            const isRunning = agent.status === 'running';
            const isError = agent.status === 'error';
            
            return (
              <Card key={agent.name} className={`glass-panel border-t-4 transition-colors ${
                isRunning ? 'border-t-primary' : 
                isError ? 'border-t-destructive' : 
                'border-t-white/10'
              }`}>
                <CardContent className="p-6">
                  <div className="flex justify-between items-start mb-4">
                    <div className={`p-3 rounded-xl bg-white/5 ${isRunning ? 'animate-pulse' : ''}`}>
                      <Icon className={`w-6 h-6 ${
                        isRunning ? 'text-primary' : 
                        isError ? 'text-destructive' : 
                        'text-muted-foreground'
                      }`} />
                    </div>
                    <Badge variant={
                      isRunning ? 'default' : 
                      isError ? 'destructive' : 
                      agent.status === 'disabled' ? 'outline' : 'secondary'
                    } className={isRunning ? 'animate-pulse' : ''}>
                      {agent.status.toUpperCase()}
                    </Badge>
                  </div>
                  
                  <h3 className="text-lg font-semibold text-white mb-1">{agent.name}</h3>
                  
                  <div className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Last Run:</span>
                      <span className="text-white font-mono text-xs">
                        {agent.lastRunAt ? formatDistanceToNow(new Date(agent.lastRunAt), { addSuffix: true }) : 'Never'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status:</span>
                      <span className={`font-mono text-xs truncate max-w-[150px] ${isError ? 'text-destructive' : 'text-success'}`}>
                        {agent.errorMessage || agent.lastResult || 'OK'}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Execution Logs */}
        <Card className="glass-panel border-white/10 mt-8">
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
                        <span className="font-semibold text-white">{run.agentName}</span>
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          {run.status === 'success' && <CheckCircle2 className="w-4 h-4 text-success" />}
                          {run.status === 'error' && <AlertTriangle className="w-4 h-4 text-destructive" />}
                          {run.status === 'skipped' && <div className="w-4 h-4 rounded-full border-2 border-muted-foreground" />}
                          <span className={`font-mono text-xs ${
                            run.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
                          }`}>
                            {run.details || `Execution completed in ${run.duration.toFixed(2)}s`}
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
}
