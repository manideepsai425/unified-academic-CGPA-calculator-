import { useEffect, useMemo, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  GitCompareArrows,
  GraduationCap,
  LayoutDashboard,
  ListTree,
  LogOut,
  Minus,
  Pencil,
  Plus,
  PlusCircle,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* ============================================================
   TYPES
   Mirrors backend/app/schemas/*.py field-for-field. There is no
   automatic sync between FastAPI and this file — if a field changes
   on one side, it must change here too, or a mismatch shows up as
   `undefined` in the UI rather than a build error.
   ============================================================ */

type RecordType = "School" | "Intermediate" | "College";
type Direction = "up" | "down" | "flat";

interface User {
  id: number;
  username: string;
  created_at: string;
}

interface AcademicRecord {
  id: number;
  user_id: number;
  period: string;
  type: RecordType;
  gpa: number;
  marks: number | null;
  max_marks: number | null;
  date: string;
  notes: string | null;
}

interface AcademicRecordInput {
  period: string;
  type: RecordType;
  gpa: number;
  marks: number | null;
  max_marks: number | null;
  date: string;
  notes: string | null;
}

interface TrendPoint {
  id: number;
  period: string;
  type: RecordType;
  gpa: number;
  date: string;
  change_percent: number | null;
  direction: Direction | null;
}

interface DashboardSummary {
  total_records: number;
  current_gpa: number | null;
  highest_gpa: number | null;
  lowest_gpa: number | null;
  overall_change_percent: number | null;
  overall_direction: Direction | null;
  trend: TrendPoint[];
}

interface ComparisonResult {
  label: string;
  marks: number;
  max_marks: number;
  percentage: number;
}

interface ApiError {
  detail: string;
}

/* ============================================================
   API CLIENT
   Every network call goes through `request()`, always with
   `credentials: "include"` — that's what makes the httpOnly auth
   cookie actually get sent. Miss it in one call site and that
   request silently looks logged-out.
   ============================================================ */

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

class ApiClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    let detail = `Request failed with status ${res.status}`;
    try {
      const body: ApiError = await res.json();
      detail = body.detail ?? detail;
    } catch {
      // Response body wasn't JSON — fall back to the generic message.
    }
    throw new ApiClientError(detail, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

function registerUser(username: string, password: string): Promise<User> {
  return request<User>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}
function loginUser(username: string, password: string): Promise<User> {
  return request<User>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}
function logoutUser(): Promise<void> {
  return request<void>("/api/auth/logout", { method: "POST" });
}
function getCurrentUser(): Promise<User> {
  return request<User>("/api/auth/me");
}
function getRecords(): Promise<AcademicRecord[]> {
  return request<AcademicRecord[]>("/api/records");
}
function getDashboard(): Promise<DashboardSummary> {
  return request<DashboardSummary>("/api/records/dashboard");
}
function createRecord(input: AcademicRecordInput): Promise<AcademicRecord> {
  return request<AcademicRecord>("/api/records", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
function updateRecord(id: number, input: Partial<AcademicRecordInput>): Promise<AcademicRecord> {
  return request<AcademicRecord>(`/api/records/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
function deleteRecord(id: number): Promise<void> {
  return request<void>(`/api/records/${id}`, { method: "DELETE" });
}
function compareMarks(
  entries: { label: string; marks: number; max_marks: number }[]
): Promise<ComparisonResult[]> {
  return request<ComparisonResult[]>("/api/compare", {
    method: "POST",
    body: JSON.stringify({ entries }),
  });
}

/* ============================================================
   VALIDATION
   Mirrors the backend's Pydantic constraints (app/schemas/*.py) so
   bad input is rejected before it reaches the network. No Zod here —
   inlined into one file, plain functions are less machinery for the
   same handful of checks a form library would otherwise centralise.
   ============================================================ */

function validateUsername(username: string): string | null {
  const trimmed = username.trim();
  if (trimmed.length < 3) return "Username must be at least 3 characters";
  if (trimmed.length > 50) return "Username must be at most 50 characters";
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return "Only letters, numbers, hyphens, and underscores";
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password must be at most 128 characters";
  return null;
}

function validateGpa(gpa: number): string | null {
  if (Number.isNaN(gpa)) return "GPA is required";
  if (gpa < 0) return "GPA cannot be negative";
  if (gpa > 10) return "GPA cannot exceed 10";
  return null;
}

function validateMarksAgainstMax(
  marks: number | null,
  maxMarks: number | null
): string | null {
  if (marks !== null && maxMarks !== null && marks > maxMarks) {
    return "Marks cannot exceed max marks";
  }
  return null;
}

/* ============================================================
   AUTH HOOK
   Single source of truth for "is anyone logged in right now". Every
   protected view checks this rather than reading the cookie directly
   (impossible — it's httpOnly, that's the point) or keeping separate
   local state that could drift from the server's actual opinion.
   ============================================================ */

function useCurrentUser() {
  const query = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const isUnauthenticated =
    query.error instanceof ApiClientError && query.error.status === 401;

  return {
    user: query.data,
    isLoading: query.isLoading,
    isUnauthenticated,
  };
}

/* ============================================================
   SMALL UI PRIMITIVES
   Inlined as plain functions rather than imported from a separate
   components/ui/ tree — this is the real cost of "one file" named
   honestly: each of these is now a single shared definition used by
   every view below, not nine separate copies, so the earlier
   "duplication across pages" trade-off from the page-per-route
   version doesn't actually apply to this architecture. What's
   flattened here is folder structure, not the sharing itself.
   ============================================================ */

function Button({
  children,
  variant = "default",
  size = "default",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "danger";
  size?: "default" | "sm" | "icon";
}) {
  const variants: Record<string, string> = {
    default:
      "bg-accent text-white shadow-card hover:bg-accent-emphasis border border-accent-emphasis/20",
    secondary: "bg-canvas-subtle text-fg border border-border shadow-card hover:bg-border/30",
    ghost: "text-fg hover:bg-canvas-subtle",
    danger:
      "bg-danger text-white shadow-card hover:bg-danger-emphasis border border-danger-emphasis/20",
  };
  const sizes: Record<string, string> = {
    default: "h-9 px-4 py-2",
    sm: "h-7 px-3 text-xs",
    icon: "h-9 w-9",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-canvas shadow-card ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 border-b border-border px-5 py-4 ${className}`}>
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold leading-none text-fg">{children}</h3>;
}

function CardContent({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}

function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`flex h-9 w-full rounded border border-border bg-canvas px-3 py-1 text-sm text-fg shadow-card transition-colors placeholder:text-fg-subtle focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
      {children}
    </label>
  );
}

function Badge({
  children,
  variant = "neutral",
}: {
  children: React.ReactNode;
  variant?: "neutral" | "success" | "danger";
}) {
  const variants: Record<string, string> = {
    neutral: "border-border bg-canvas-subtle text-fg-muted",
    success: "border-success/20 bg-success-subtle text-success-emphasis",
    danger: "border-danger/20 bg-danger-subtle text-danger-emphasis",
  };
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${variants[variant]}`}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
    </div>
  );
}

/* ============================================================
   VIEW ROUTING (client-side, no URLs)
   This replaces Next.js's file-based router. There is no /dashboard,
   no /history — everything lives at one address, and `currentView`
   decides what's on screen. Trade-off, stated plainly: no bookmarking
   a specific view, no browser back-button between views, no link you
   can hand someone straight to "history". That's the real cost of
   collapsing routing into one file, not a hidden one.
   ============================================================ */

type View = "login" | "register" | "dashboard" | "history" | "add" | "compare";

const NAV_LINKS: { view: View; label: string; icon: typeof LayoutDashboard }[] = [
  { view: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { view: "history", label: "History", icon: ListTree },
  { view: "add", label: "Add result", icon: PlusCircle },
  { view: "compare", label: "Compare", icon: GitCompareArrows },
];

function TopNav({
  user,
  onLogout,
}: {
  user: User | undefined;
  onLogout: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-canvas px-4 sm:px-6">
      <div className="flex items-center gap-2 text-fg">
        <GraduationCap className="h-5 w-5 text-accent" strokeWidth={2} />
        <span className="text-sm font-semibold">Academic GPA Tracker</span>
      </div>
      {user && (
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-fg-muted sm:inline">{user.username}</span>
          <Button variant="ghost" size="sm" onClick={onLogout} className="gap-1.5">
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      )}
    </header>
  );
}

function Sidebar({ currentView, onNavigate }: { currentView: View; onNavigate: (v: View) => void }) {
  return (
    <aside className="hidden w-56 shrink-0 border-r border-border bg-canvas-subtle/50 md:block">
      <nav className="sticky top-14 flex flex-col gap-0.5 p-3">
        {NAV_LINKS.map(({ view, label, icon: Icon }) => {
          const isActive = currentView === view;
          return (
            <button
              key={view}
              onClick={() => onNavigate(view)}
              className={`flex items-center gap-2.5 rounded px-3 py-1.5 text-left text-sm transition-colors ${
                isActive
                  ? "bg-accent-subtle font-semibold text-accent-emphasis"
                  : "text-fg-muted hover:bg-canvas-subtle hover:text-fg"
              }`}
            >
              <Icon className="h-4 w-4" strokeWidth={isActive ? 2.25 : 2} />
              {label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function MobileNav({ currentView, onNavigate }: { currentView: View; onNavigate: (v: View) => void }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-border bg-canvas md:hidden">
      {NAV_LINKS.map(({ view, label, icon: Icon }) => {
        const isActive = currentView === view;
        return (
          <button
            key={view}
            onClick={() => onNavigate(view)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              isActive ? "text-accent" : "text-fg-muted"
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={isActive ? 2.25 : 2} />
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function AppShell({
  user,
  currentView,
  onNavigate,
  onLogout,
  children,
}: {
  user: User | undefined;
  currentView: View;
  onNavigate: (v: View) => void;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <TopNav user={user} onLogout={onLogout} />
      <div className="flex flex-1">
        <Sidebar currentView={currentView} onNavigate={onNavigate} />
        <main className="flex-1 px-4 pb-20 pt-6 sm:px-6 md:pb-6">{children}</main>
      </div>
      <MobileNav currentView={currentView} onNavigate={onNavigate} />
    </div>
  );
}

/* ============================================================
   LOGIN VIEW
   ============================================================ */

function LoginView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function validate(): boolean {
    const errors: { username?: string; password?: string } = {};
    if (username.trim().length === 0) errors.username = "Username is required";
    if (password.length === 0) errors.password = "Password is required";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      await loginUser(username, password);
      await queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      onNavigate("dashboard");
    } catch (err) {
      // Deliberately generic — matches the backend's identical error
      // for "no such user" vs "wrong password", so this message can't
      // be used to enumerate valid usernames.
      setServerError(
        err instanceof ApiClientError ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas-subtle px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <GraduationCap className="h-9 w-9 text-accent" strokeWidth={1.75} />
          <h1 className="text-lg font-semibold text-fg">Academic GPA Tracker</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <p className="text-xs text-fg-muted">Enter your username and password to continue.</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-username">Username</Label>
                <Input
                  id="login-username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  aria-invalid={!!fieldErrors.username}
                />
                {fieldErrors.username && <p className="text-xs text-danger">{fieldErrors.username}</p>}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fieldErrors.password}
                />
                {fieldErrors.password && <p className="text-xs text-danger">{fieldErrors.password}</p>}
              </div>
              {serverError && (
                <div className="rounded border border-danger/20 bg-danger-subtle px-3 py-2 text-xs text-danger-emphasis">
                  {serverError}
                </div>
              )}
              <Button type="submit" disabled={isSubmitting} className="mt-1">
                {isSubmitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-sm text-fg-muted">
          Don&apos;t have an account?{" "}
          <button onClick={() => onNavigate("register")} className="text-accent hover:underline">
            Register
          </button>
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   REGISTER VIEW
   ============================================================ */

function RegisterView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function validate(): boolean {
    const errors: { username?: string; password?: string } = {};
    const usernameError = validateUsername(username);
    const passwordError = validatePassword(password);
    if (usernameError) errors.username = usernameError;
    if (passwordError) errors.password = passwordError;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      await registerUser(username.trim(), password);
      await queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      onNavigate("dashboard");
    } catch (err) {
      // A specific message is fine here — registration inherently
      // reveals whether a username is taken via the 409 itself.
      setServerError(
        err instanceof ApiClientError ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas-subtle px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <GraduationCap className="h-9 w-9 text-accent" strokeWidth={1.75} />
          <h1 className="text-lg font-semibold text-fg">Academic GPA Tracker</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Create an account</CardTitle>
            <p className="text-xs text-fg-muted">Choose a username and password to get started.</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="register-username">Username</Label>
                <Input
                  id="register-username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  aria-invalid={!!fieldErrors.username}
                />
                {fieldErrors.username && <p className="text-xs text-danger">{fieldErrors.username}</p>}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="register-password">Password</Label>
                <Input
                  id="register-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fieldErrors.password}
                />
                {fieldErrors.password && <p className="text-xs text-danger">{fieldErrors.password}</p>}
                <p className="text-xs text-fg-subtle">At least 8 characters.</p>
              </div>
              {serverError && (
                <div className="rounded border border-danger/20 bg-danger-subtle px-3 py-2 text-xs text-danger-emphasis">
                  {serverError}
                </div>
              )}
              <Button type="submit" disabled={isSubmitting} className="mt-1">
                {isSubmitting ? "Creating account…" : "Create account"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-sm text-fg-muted">
          Already have an account?{" "}
          <button onClick={() => onNavigate("login")} className="text-accent hover:underline">
            Sign in
          </button>
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   DASHBOARD VIEW
   ============================================================ */

function GpaTrendChart({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-fg-muted">
        Add your first result to see your trend here.
      </div>
    );
  }

  return (
    <div className="h-64 w-full sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={trend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="gpaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0969da" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#0969da" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#d0d7de" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="period"
            tick={{ fontSize: 11, fill: "#656d76" }}
            axisLine={{ stroke: "#d0d7de" }}
            tickLine={false}
          />
          <YAxis
            domain={[0, 10]}
            tick={{ fontSize: 11, fill: "#656d76" }}
            axisLine={false}
            tickLine={false}
            width={28}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as TrendPoint;
              return (
                <div className="rounded-lg border border-border bg-canvas px-3 py-2 shadow-overlay">
                  <p className="text-xs font-semibold text-fg">{point.period}</p>
                  <p className="font-numeric text-sm text-fg">{point.gpa.toFixed(2)} GPA</p>
                  {point.change_percent !== null && (
                    <p
                      className={`font-numeric text-xs ${
                        point.direction === "up"
                          ? "text-success"
                          : point.direction === "down"
                            ? "text-danger"
                            : "text-fg-muted"
                      }`}
                    >
                      {point.change_percent > 0 ? "+" : ""}
                      {point.change_percent}% vs previous
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-fg-subtle">
                    {format(new Date(point.date), "d MMM yyyy")}
                  </p>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="gpa"
            stroke="#0969da"
            strokeWidth={2}
            fill="url(#gpaFill)"
            dot={{ r: 3, fill: "#0969da", strokeWidth: 0 }}
            activeDot={{ r: 5, fill: "#0969da", strokeWidth: 2, stroke: "#ffffff" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function DirectionBadge({
  direction,
  percent,
}: {
  direction: Direction | null;
  percent: number | null;
}) {
  if (direction === null || percent === null) return <Badge variant="neutral">No history yet</Badge>;
  if (direction === "up")
    return (
      <Badge variant="success">
        <TrendingUp className="h-3 w-3" /> +{percent}%
      </Badge>
    );
  if (direction === "down")
    return (
      <Badge variant="danger">
        <TrendingDown className="h-3 w-3" /> {percent}%
      </Badge>
    );
  return (
    <Badge variant="neutral">
      <Minus className="h-3 w-3" /> No change
    </Badge>
  );
}

function SummaryCards({ summary }: { summary: DashboardSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          <span className="text-xs text-fg-muted">Current GPA</span>
          <span className="font-numeric text-2xl font-semibold text-fg">
            {summary.current_gpa !== null ? summary.current_gpa.toFixed(2) : "—"}
          </span>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          <span className="text-xs text-fg-muted">Overall trend</span>
          <DirectionBadge direction={summary.overall_direction} percent={summary.overall_change_percent} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          <span className="text-xs text-fg-muted">Highest GPA</span>
          <span className="font-numeric text-2xl font-semibold text-fg">
            {summary.highest_gpa !== null ? summary.highest_gpa.toFixed(2) : "—"}
          </span>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          <span className="text-xs text-fg-muted">Total records</span>
          <span className="font-numeric text-2xl font-semibold text-fg">{summary.total_records}</span>
        </CardContent>
      </Card>
    </div>
  );
}

function TrendList({ trend }: { trend: TrendPoint[] }) {
  const reversed = [...trend].reverse();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Semester-by-semester change</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        {reversed.map((point) => (
          <div key={point.id} className="flex items-center justify-between px-5 py-3">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-fg">{point.period}</span>
              <span className="text-xs text-fg-subtle">
                {format(new Date(point.date), "d MMM yyyy")} · {point.type}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-numeric text-sm font-semibold text-fg">{point.gpa.toFixed(2)}</span>
              {point.change_percent === null ? (
                <span className="text-xs text-fg-subtle">First record</span>
              ) : point.direction === "up" ? (
                <span className="flex items-center gap-1 font-numeric text-xs font-medium text-success">
                  <TrendingUp className="h-3.5 w-3.5" />+{point.change_percent}%
                </span>
              ) : point.direction === "down" ? (
                <span className="flex items-center gap-1 font-numeric text-xs font-medium text-danger">
                  <TrendingDown className="h-3.5 w-3.5" />
                  {point.change_percent}%
                </span>
              ) : (
                <span className="flex items-center gap-1 font-numeric text-xs font-medium text-fg-muted">
                  <Minus className="h-3.5 w-3.5" />
                  0%
                </span>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function DashboardView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboard,
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg">Dashboard</h1>
        <Button size="sm" onClick={() => onNavigate("add")}>
          Add result
        </Button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError || !data ? (
        <div className="rounded-lg border border-danger/20 bg-danger-subtle px-4 py-3 text-sm text-danger-emphasis">
          Couldn&apos;t load your dashboard. Please try refreshing.
        </div>
      ) : data.total_records === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <CardTitle>No results yet</CardTitle>
            <p className="max-w-sm text-sm text-fg-muted">
              Add your first academic result — School, Intermediate, or a College semester — to
              start seeing your GPA trend.
            </p>
            <Button onClick={() => onNavigate("add")}>Add your first result</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <SummaryCards summary={data} />
          <Card>
            <CardHeader>
              <CardTitle>GPA trend</CardTitle>
            </CardHeader>
            <CardContent>
              <GpaTrendChart trend={data.trend} />
            </CardContent>
          </Card>
          <TrendList trend={data.trend} />
        </div>
      )}
    </div>
  );
}

/* ============================================================
   HISTORY VIEW
   Sortable table with edit/delete. Modals are plain conditionally-
   rendered overlays rather than a Radix Dialog import — inlined into
   one file, a hand-rolled overlay is less machinery for the same
   "click outside or press the button to close" behavior Radix's
   Dialog otherwise provides.
   ============================================================ */

type SortKey = "period" | "type" | "gpa" | "date";
type SortDirection = "asc" | "desc";

const HISTORY_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "period", label: "Period" },
  { key: "type", label: "Type" },
  { key: "gpa", label: "GPA" },
  { key: "date", label: "Date" },
];

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 px-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-canvas p-6 shadow-overlay">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-fg">{title}</h3>
          <button onClick={onClose} className="rounded-sm opacity-70 hover:opacity-100">
            <X className="h-4 w-4 text-fg-muted" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EditRecordModal({
  record,
  open,
  onClose,
}: {
  record: AcademicRecord | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState("");
  const [type, setType] = useState<RecordType>("College");
  const [gpa, setGpa] = useState("");
  const [marks, setMarks] = useState("");
  const [maxMarks, setMaxMarks] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Re-populate whenever a different record is opened for editing —
  // without this, the form would keep showing whichever record was
  // edited first, since state doesn't auto-reset on a changed prop.
  useEffect(() => {
    if (record) {
      setPeriod(record.period);
      setType(record.type);
      setGpa(String(record.gpa));
      setMarks(record.marks !== null ? String(record.marks) : "");
      setMaxMarks(record.max_marks !== null ? String(record.max_marks) : "");
      setDate(record.date.slice(0, 10));
      setNotes(record.notes ?? "");
      setError(null);
    }
  }, [record]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("No record selected");
      const gpaNum = parseFloat(gpa);
      const marksNum = marks.trim() === "" ? null : parseFloat(marks);
      const maxMarksNum = maxMarks.trim() === "" ? null : parseFloat(maxMarks);
      return updateRecord(record.id, {
        period,
        type,
        gpa: gpaNum,
        marks: marksNum,
        max_marks: maxMarksNum,
        date: new Date(date).toISOString(),
        notes: notes.trim() === "" ? null : notes,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
    onError: () => setError("Couldn't save changes. Please try again."),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const gpaError = validateGpa(parseFloat(gpa));
    if (gpaError) return setError(gpaError);
    const marksError = validateMarksAgainstMax(
      marks.trim() === "" ? null : parseFloat(marks),
      maxMarks.trim() === "" ? null : parseFloat(maxMarks)
    );
    if (marksError) return setError(marksError);
    mutation.mutate();
  }

  if (!record) return null;

  return (
    <Modal open={open} onClose={onClose} title="Edit result">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-period">Period</Label>
            <Input id="edit-period" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-type">Type</Label>
            <select
              id="edit-type"
              value={type}
              onChange={(e) => setType(e.target.value as RecordType)}
              className="flex h-9 w-full rounded border border-border bg-canvas px-3 py-1 text-sm text-fg shadow-card focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              <option value="School">School</option>
              <option value="Intermediate">Intermediate</option>
              <option value="College">College</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-gpa">GPA (0–10)</Label>
            <Input
              id="edit-gpa"
              type="number"
              step="0.01"
              className="font-numeric"
              value={gpa}
              onChange={(e) => setGpa(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-date">Date</Label>
            <Input id="edit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-marks">Marks (optional)</Label>
            <Input
              id="edit-marks"
              type="number"
              step="0.01"
              className="font-numeric"
              value={marks}
              onChange={(e) => setMarks(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-max-marks">Out of (optional)</Label>
            <Input
              id="edit-max-marks"
              type="number"
              step="0.01"
              className="font-numeric"
              value={maxMarks}
              onChange={(e) => setMaxMarks(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-notes">Notes (optional)</Label>
          <Input id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteRecordModal({
  record,
  open,
  onClose,
}: {
  record: AcademicRecord | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("No record selected");
      return deleteRecord(record.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
  });

  if (!record) return null;

  return (
    <Modal open={open} onClose={onClose} title="Delete this result?">
      <p className="mb-4 text-sm text-fg-muted">
        This will permanently delete the record for <strong>{record.period}</strong> (GPA{" "}
        {record.gpa.toFixed(2)}). This action cannot be undone.
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </Modal>
  );
}

function HistoryView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["records"],
    queryFn: getRecords,
  });

  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [editingRecord, setEditingRecord] = useState<AcademicRecord | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<AcademicRecord | null>(null);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  }

  const sorted = useMemo(() => {
    if (!data) return [];
    const copy = [...data];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "period") cmp = a.period.localeCompare(b.period);
      else if (sortKey === "type") cmp = a.type.localeCompare(b.type);
      else if (sortKey === "gpa") cmp = a.gpa - b.gpa;
      else if (sortKey === "date") cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [data, sortKey, sortDirection]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg">History</h1>
        <Button size="sm" onClick={() => onNavigate("add")}>
          Add result
        </Button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError || !data ? (
        <div className="rounded-lg border border-danger/20 bg-danger-subtle px-4 py-3 text-sm text-danger-emphasis">
          Couldn&apos;t load your history. Please try refreshing.
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            {sorted.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-fg-muted">
                No results yet. Add your first one to see it here.
              </div>
            ) : (
              <div className="relative w-full overflow-auto rounded-lg">
                <table className="w-full caption-bottom text-sm">
                  <thead className="bg-canvas-subtle">
                    <tr>
                      {HISTORY_COLUMNS.map(({ key, label }) => (
                        <th key={key} className="h-10 px-4 text-left align-middle text-xs font-semibold text-fg-muted">
                          <button
                            onClick={() => handleSort(key)}
                            className={`flex items-center gap-1 transition-colors hover:text-fg ${
                              sortKey === key ? "text-fg" : ""
                            }`}
                          >
                            {label}
                            {sortKey === key ? (
                              sortDirection === "asc" ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ArrowUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </th>
                      ))}
                      <th className="h-10 px-4 text-left align-middle text-xs font-semibold text-fg-muted">
                        Marks
                      </th>
                      <th className="h-10 px-4 text-right align-middle text-xs font-semibold text-fg-muted">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sorted.map((record) => (
                      <tr key={record.id} className="transition-colors hover:bg-canvas-subtle/60">
                        <td className="px-4 py-3 font-medium text-fg">{record.period}</td>
                        <td className="px-4 py-3 text-fg-muted">{record.type}</td>
                        <td className="px-4 py-3 font-numeric font-semibold text-fg">
                          {record.gpa.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 font-numeric text-fg-muted">
                          {format(new Date(record.date), "d MMM yyyy")}
                        </td>
                        <td className="px-4 py-3 font-numeric text-fg-muted">
                          {record.marks !== null && record.max_marks !== null
                            ? `${record.marks}/${record.max_marks}`
                            : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => setEditingRecord(record)}>
                              <Pencil className="h-4 w-4 text-fg-muted" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => setDeletingRecord(record)}>
                              <Trash2 className="h-4 w-4 text-danger" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <EditRecordModal record={editingRecord} open={editingRecord !== null} onClose={() => setEditingRecord(null)} />
      <DeleteRecordModal record={deletingRecord} open={deletingRecord !== null} onClose={() => setDeletingRecord(null)} />
    </div>
  );
}

/* ============================================================
   ADD RESULT VIEW
   Includes "smart period suggestions": if the highest existing
   College semester on record is "Semester 4", the top suggestion is
   "Semester 5" — pattern-matched against period strings already
   saved, not a general academic calendar.
   ============================================================ */

function suggestPeriods(existingPeriods: string[], type: RecordType): string[] {
  if (type === "School") return ["Class 10", "Class 9", "Class 8"];
  if (type === "Intermediate") return ["Intermediate 2nd Year", "Intermediate 1st Year"];

  const semesterNumbers = existingPeriods
    .map((p) => {
      const match = p.match(/semester\s*(\d+)/i);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((n): n is number => n !== null);

  const highest = semesterNumbers.length > 0 ? Math.max(...semesterNumbers) : 0;
  const next = highest + 1;
  const suggestions = [`Semester ${next}`];
  if (next > 1) suggestions.push(`Semester ${next - 1} (re-entry)`);
  if (next <= 8) suggestions.push(`Semester ${Math.min(next + 1, 8)}`);
  return suggestions;
}

function AddResultView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const queryClient = useQueryClient();
  const { data: existingRecords } = useQuery({ queryKey: ["records"], queryFn: getRecords });

  const [type, setType] = useState<RecordType>("College");
  const [period, setPeriod] = useState("");
  const [gpa, setGpa] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [marks, setMarks] = useState("");
  const [maxMarks, setMaxMarks] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const suggestions = useMemo(
    () => suggestPeriods((existingRecords ?? []).map((r) => r.period), type),
    [existingRecords, type]
  );

  const mutation = useMutation({
    mutationFn: () =>
      createRecord({
        period,
        type,
        gpa: parseFloat(gpa),
        marks: marks.trim() === "" ? null : parseFloat(marks),
        max_marks: maxMarks.trim() === "" ? null : parseFloat(maxMarks),
        date: new Date(date).toISOString(),
        notes: notes.trim() === "" ? null : notes,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onNavigate("dashboard");
    },
    onError: () => setError("Couldn't save this result. Please check the values and try again."),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (period.trim().length === 0) return setError("Period is required");
    const gpaError = validateGpa(parseFloat(gpa));
    if (gpaError) return setError(gpaError);
    const marksError = validateMarksAgainstMax(
      marks.trim() === "" ? null : parseFloat(marks),
      maxMarks.trim() === "" ? null : parseFloat(maxMarks)
    );
    if (marksError) return setError(marksError);
    mutation.mutate();
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5">
      <h1 className="text-xl font-semibold text-fg">Add new result</h1>
      <Card>
        <CardHeader>
          <CardTitle>Add a new result</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-type">Type</Label>
              <select
                id="add-type"
                value={type}
                onChange={(e) => setType(e.target.value as RecordType)}
                className="flex h-9 w-full rounded border border-border bg-canvas px-3 py-1 text-sm text-fg shadow-card focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              >
                <option value="School">School</option>
                <option value="Intermediate">Intermediate</option>
                <option value="College">College</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-period">Period</Label>
              <Input
                id="add-period"
                placeholder="e.g. Semester 5"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setPeriod(s)}
                      className="rounded-full border border-border bg-canvas-subtle px-2.5 py-0.5 text-xs text-fg-muted transition-colors hover:border-accent hover:text-accent"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-gpa">GPA (0–10)</Label>
                <Input
                  id="add-gpa"
                  type="number"
                  step="0.01"
                  placeholder="8.70"
                  className="font-numeric"
                  value={gpa}
                  onChange={(e) => setGpa(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-date">Date</Label>
                <Input id="add-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-marks">Marks (optional)</Label>
                <Input
                  id="add-marks"
                  type="number"
                  step="0.01"
                  placeholder="e.g. 652"
                  className="font-numeric"
                  value={marks}
                  onChange={(e) => setMarks(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-max-marks">Out of (optional)</Label>
                <Input
                  id="add-max-marks"
                  type="number"
                  step="0.01"
                  placeholder="e.g. 1000"
                  className="font-numeric"
                  value={maxMarks}
                  onChange={(e) => setMaxMarks(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-notes">Notes (optional)</Label>
              <Input
                id="add-notes"
                placeholder="Anything worth remembering about this result"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && (
              <div className="rounded border border-danger/20 bg-danger-subtle px-3 py-2 text-xs text-danger-emphasis">
                {error}
              </div>
            )}

            <Button type="submit" disabled={mutation.isPending} className="mt-1">
              {mutation.isPending ? "Saving…" : "Save result"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/* ============================================================
   COMPARE VIEW
   Manual multi-entry only, capped at 5, never linked to any account
   — this is unchanged from the original scoping decision: a real
   user-lookup comparison feature would let any of 100+ users pull up
   a stranger's full academic history with zero consent. Nothing
   about collapsing this into one file touches that boundary.
   ============================================================ */

const MAX_COMPARISON_ENTRIES = 5;

interface DraftEntry {
  id: string;
  label: string;
  marks: string;
  max_marks: string;
}

function makeEmptyEntry(defaultLabel: string): DraftEntry {
  return { id: crypto.randomUUID(), label: defaultLabel, marks: "", max_marks: "1000" };
}

function ComparisonChart({ results }: { results: ComparisonResult[] }) {
  return (
    <div className="h-64 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={results} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#d0d7de" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "#656d76" }}
            axisLine={{ stroke: "#d0d7de" }}
            tickLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: "#656d76" }}
            axisLine={false}
            tickLine={false}
            width={32}
            unit="%"
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as ComparisonResult;
              return (
                <div className="rounded-lg border border-border bg-canvas px-3 py-2 shadow-overlay">
                  <p className="text-xs font-semibold text-fg">{point.label}</p>
                  <p className="font-numeric text-sm text-fg">
                    {point.marks}/{point.max_marks}
                  </p>
                  <p className="font-numeric text-xs text-accent">{point.percentage}%</p>
                </div>
              );
            }}
          />
          <Bar dataKey="percentage" fill="#0969da" radius={[4, 4, 0, 0]} maxBarSize={64} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CompareView() {
  const [entries, setEntries] = useState<DraftEntry[]>([
    makeEmptyEntry("Me"),
    makeEmptyEntry("Friend A"),
  ]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [results, setResults] = useState<ComparisonResult[] | null>(null);

  const mutation = useMutation({
    mutationFn: compareMarks,
    onSuccess: (data) => setResults(data),
  });

  function updateEntry(id: string, field: keyof Omit<DraftEntry, "id">, value: string) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  }

  function addEntry() {
    if (entries.length >= MAX_COMPARISON_ENTRIES) return;
    setEntries((prev) => [...prev, makeEmptyEntry(`Friend ${prev.length}`)]);
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);
    setResults(null);

    const parsed: { label: string; marks: number; max_marks: number }[] = [];
    for (const entry of entries) {
      const label = entry.label.trim();
      const marks = parseFloat(entry.marks);
      const maxMarks = parseFloat(entry.max_marks);

      if (label.length === 0) return setValidationError("Every entry needs a label");
      if (Number.isNaN(marks) || marks < 0) {
        return setValidationError(`${label}: marks must be a non-negative number`);
      }
      if (Number.isNaN(maxMarks) || maxMarks <= 0) {
        return setValidationError(`${label}: max marks must be greater than 0`);
      }
      parsed.push({ label, marks, max_marks: maxMarks });
    }

    mutation.mutate(parsed);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <h1 className="text-xl font-semibold text-fg">Compare</h1>
      <Card>
        <CardHeader>
          <CardTitle>Compare marks</CardTitle>
          <p className="text-xs text-fg-muted">
            Enter marks manually for up to {MAX_COMPARISON_ENTRIES} people — for example,
            852/1000. Nothing here is saved or linked to any account.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor={`label-${entry.id}`}>Label</Label>
                  <Input
                    id={`label-${entry.id}`}
                    value={entry.label}
                    onChange={(e) => updateEntry(entry.id, "label", e.target.value)}
                    placeholder="e.g. Me"
                  />
                </div>
                <div className="flex w-24 flex-col gap-1.5">
                  <Label htmlFor={`marks-${entry.id}`}>Marks</Label>
                  <Input
                    id={`marks-${entry.id}`}
                    type="number"
                    step="0.01"
                    className="font-numeric"
                    value={entry.marks}
                    onChange={(e) => updateEntry(entry.id, "marks", e.target.value)}
                    placeholder="852"
                  />
                </div>
                <div className="flex w-24 flex-col gap-1.5">
                  <Label htmlFor={`max-${entry.id}`}>Out of</Label>
                  <Input
                    id={`max-${entry.id}`}
                    type="number"
                    step="0.01"
                    className="font-numeric"
                    value={entry.max_marks}
                    onChange={(e) => updateEntry(entry.id, "max_marks", e.target.value)}
                    placeholder="1000"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeEntry(entry.id)}
                  disabled={entries.length <= 1}
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </div>
            ))}

            {entries.length < MAX_COMPARISON_ENTRIES && (
              <Button type="button" variant="secondary" size="sm" onClick={addEntry} className="w-fit gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Add person ({entries.length}/{MAX_COMPARISON_ENTRIES})
              </Button>
            )}

            {validationError && <p className="text-xs text-danger">{validationError}</p>}

            <Button type="submit" disabled={mutation.isPending} className="mt-1 w-fit">
              {mutation.isPending ? "Comparing…" : "Compare"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {results && (
        <Card>
          <CardHeader>
            <CardTitle>Results</CardTitle>
          </CardHeader>
          <CardContent>
            <ComparisonChart results={results} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ============================================================
   ROOT APP COMPONENT
   This is the actual "App.tsx instead of page.tsx" mechanism: one
   piece of state (`currentView`) decides what renders, replacing
   Next.js's file-based router entirely. The QueryClient is created
   inside useState (not as a module-level singleton) so each browser
   session gets its own instance.
   ============================================================ */

function AuthenticatedApp() {
  const { user, isLoading, isUnauthenticated } = useCurrentUser();
  const queryClient = useQueryClient();
  const [currentView, setCurrentView] = useState<View>("dashboard");
  const [authView, setAuthView] = useState<"login" | "register">("login");

  async function handleLogout() {
    await logoutUser();
    // Clear every cached query, not just currentUser — otherwise a
    // different user logging in on the same tab shortly after could
    // briefly render with the previous user's cached dashboard data.
    queryClient.clear();
    setCurrentView("dashboard");
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }

  if (isUnauthenticated || !user) {
    return authView === "login" ? (
      <LoginView onNavigate={(v) => setAuthView(v === "register" ? "register" : "login")} />
    ) : (
      <RegisterView onNavigate={(v) => setAuthView(v === "login" ? "login" : "register")} />
    );
  }

  return (
    <AppShell user={user} currentView={currentView} onNavigate={setCurrentView} onLogout={handleLogout}>
      {currentView === "dashboard" && <DashboardView onNavigate={setCurrentView} />}
      {currentView === "history" && <HistoryView onNavigate={setCurrentView} />}
      {currentView === "add" && <AddResultView onNavigate={setCurrentView} />}
      {currentView === "compare" && <CompareView />}
    </AppShell>
  );
}

export default function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 30 * 1000,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthenticatedApp />
    </QueryClientProvider>
  );
}
