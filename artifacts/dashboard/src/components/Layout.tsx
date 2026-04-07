import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Activity, 
  History, 
  Cpu, 
  Settings, 
  TrendingUp,
  Zap,
  FlaskConical,
  FileText,
  BrainCircuit,
  DollarSign,
  BarChart3
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetDashboardOverview, getGetDashboardOverviewQueryKey } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";

const API_BASE = `${import.meta.env.BASE_URL}api`;

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { data: overview } = useGetDashboardOverview({ query: { queryKey: getGetDashboardOverviewQueryKey(), refetchInterval: 10000 } });

  const { data: costs } = useQuery({
    queryKey: ["/api/costs/sidebar"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/costs`);
      return res.json();
    },
    refetchInterval: 30000,
  });

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/brain", label: "Decision Brain", icon: BrainCircuit },
    { href: "/opportunities", label: "Opportunities", icon: Activity },
    { href: "/trades", label: "Trade History", icon: History },
    { href: "/paper", label: "Paper Trading", icon: FileText },
    { href: "/agents", label: "Agent Status", icon: Cpu },
    { href: "/backtest", label: "Backtest", icon: FlaskConical },
    { href: "/backtests", label: "Backtests", icon: BarChart3 },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <aside className="w-64 border-r border-white/5 bg-card/30 backdrop-blur-xl flex flex-col fixed inset-y-0 z-10">
        <div className="h-16 flex items-center px-6 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
              <TrendingUp className="w-5 h-5 text-white" />
            </div>
            <span className="font-display font-bold text-lg text-white tracking-tight">Kalshi<span className="text-primary">AI</span></span>
          </div>
        </div>

        <div className="flex-1 py-6 flex flex-col gap-1 px-3 overflow-y-auto">
          <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Navigation</div>
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 text-sm font-medium",
                  isActive 
                    ? "bg-primary/10 text-primary shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]" 
                    : "text-muted-foreground hover:bg-white/5 hover:text-white"
                )}
              >
                <item.icon className={cn("w-4 h-4", isActive ? "text-primary" : "text-muted-foreground")} />
                {item.label}
              </Link>
            );
          })}
        </div>

        <div className="border-t border-white/5 bg-black/20">
          <div className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Pipeline</span>
              <div className="flex items-center gap-2">
                {overview?.pipelineActive ? (
                  <>
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success shadow-[0_0_10px_rgba(var(--color-success),0.5)]"></span>
                    </span>
                    <span className="text-xs font-bold text-success uppercase tracking-wider">Active</span>
                  </>
                ) : (
                  <>
                    <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground"></span>
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Halted</span>
                  </>
                )}
              </div>
            </div>
            {overview?.paperTradingMode && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <FileText className="w-3 h-3 text-yellow-400" />
                <span className="text-xs font-bold text-yellow-400 uppercase tracking-wider">Paper Mode</span>
              </div>
            )}
            {overview?.lastRunAt && (
               <div className="mt-2 text-xs text-muted-foreground/70 flex items-center gap-1">
                 <Zap className="w-3 h-3" />
                 Last run: {new Date(overview.lastRunAt).toLocaleTimeString()}
               </div>
            )}
          </div>
          {costs && (
            <div className="px-4 pb-4 pt-0">
              <div className="p-3 rounded-lg bg-black/30 border border-white/5">
                <div className="flex items-center gap-1.5 mb-2">
                  <DollarSign className="w-3 h-3 text-primary" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">API Costs</span>
                  {costs.budgetPaused && (
                    <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-destructive/20 text-destructive border border-destructive/30">PAUSED</span>
                  )}
                </div>
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] text-muted-foreground">Today</span>
                      <span className="text-xs font-mono text-white">
                        ${costs.daily?.costUsd?.toFixed(4) || "0.00"}
                        {costs.daily?.budgetUsd > 0 && <span className="text-muted-foreground/60"> / ${costs.daily.budgetUsd}</span>}
                      </span>
                    </div>
                    {costs.daily?.budgetUsd > 0 && (
                      <div className="w-full h-1 bg-white/5 rounded-full mt-1 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${costs.daily.exceeded ? "bg-destructive" : "bg-primary"}`}
                          style={{ width: `${Math.min(100, ((costs.daily.costUsd || 0) / costs.daily.budgetUsd) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] text-muted-foreground">Month</span>
                      <span className="text-xs font-mono text-white">
                        ${costs.monthly?.costUsd?.toFixed(4) || "0.00"}
                        {costs.monthly?.budgetUsd > 0 && <span className="text-muted-foreground/60"> / ${costs.monthly.budgetUsd}</span>}
                      </span>
                    </div>
                    {costs.monthly?.budgetUsd > 0 && (
                      <div className="w-full h-1 bg-white/5 rounded-full mt-1 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${costs.monthly.exceeded ? "bg-destructive" : "bg-primary"}`}
                          style={{ width: `${Math.min(100, ((costs.monthly.costUsd || 0) / costs.monthly.budgetUsd) * 100)}%` }}
                        />
                      </div>
                    )}
                    {costs.monthly?.projectedUsd > 0 && (
                      <div className="flex justify-between items-center mt-1">
                        <span className="text-[9px] text-muted-foreground/60">Projected EOM</span>
                        <span className={`text-[10px] font-mono ${costs.monthly.budgetUsd > 0 && costs.monthly.projectedUsd > costs.monthly.budgetUsd ? "text-destructive" : "text-muted-foreground/80"}`}>
                          ${costs.monthly.projectedUsd.toFixed(4)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 ml-64 flex flex-col min-h-screen">
        <header className="h-16 border-b border-white/5 bg-background/80 backdrop-blur-md sticky top-0 z-10 flex items-center justify-between px-8">
          <h1 className="font-display font-semibold text-lg text-white">
            {navItems.find(i => i.href === location)?.label || "Dashboard"}
          </h1>
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {overview?.paperTradingMode ? "Paper Balance" : "Portfolio Balance"}
                </span>
                {!overview?.paperTradingMode && (
                  <span className="relative flex items-center gap-1 px-1.5 py-0.5 rounded bg-success/10 border border-success/20">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className={`${overview?.pipelineActive ? "animate-ping" : ""} absolute inline-flex h-full w-full rounded-full bg-success opacity-75`}></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success"></span>
                    </span>
                    <span className="text-[10px] font-bold text-success uppercase tracking-wider">Live</span>
                  </span>
                )}
              </div>
              <span className="font-mono font-bold text-white">
                {!overview ? '...' : overview.balanceError ? (
                  <span className="text-destructive text-xs">Balance unavailable</span>
                ) : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(overview.balance)}
              </span>
            </div>
          </div>
        </header>
        <div className="p-8 flex-1 animate-in fade-in duration-500">
          {children}
        </div>
      </main>
    </div>
  );
}
