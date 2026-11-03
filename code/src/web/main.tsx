import { render } from "preact";
import { useEffect } from "preact/hooks";
import { AgentsPage } from "./features/agents/agents-page";
import { PendingApprovals } from "./features/approvals/approvals";
import { AccountPage } from "./features/auth/account-page";
import { EnrollPage } from "./features/auth/enroll-page";
import { LoginPage } from "./features/auth/login-page";
import { canDecideApprovals, me, refreshMe } from "./features/auth/me";
import { BoardPage } from "./features/board/board-page";
import { ChatPage } from "./features/chat/chat-page";
import { DashboardPage } from "./features/dashboard/dashboard-page";
import { HiringPage } from "./features/hiring/hiring-page";
import { OrgPage } from "./features/orgs/org-page";
import { selectedSlug } from "./features/orgs/org-switcher";
import { PoliciesPage } from "./features/policies/policies-page";
import { RunPage } from "./features/runs/run-page";
import { RunsPage } from "./features/runs/runs-page";
import { SearchPage } from "./features/search/search-page";
import { Header } from "./header";
import { routeParts } from "./route";

function OrgRoute({ parts }: { parts: string[] }): preact.JSX.Element {
  const slug = parts[1] ?? "";
  if (parts[2] === "chat") return <ChatPage slug={slug} />;
  if (parts[2] === "settings") return <OrgPage slug={slug} />;
  if (parts[2] === "dashboard") return <DashboardPage slug={slug} />;
  if (parts[2] === "hiring") return <HiringPage />;
  if (parts[2] === "policies") return <PoliciesPage slug={slug} />;
  const taskNumber = Number(parts[4]);
  return (
    <BoardPage
      slug={slug}
      {...(parts[3] && { projectId: parts[3] })}
      {...(taskNumber > 0 && { taskNumber })}
    />
  );
}

function Page(): preact.JSX.Element {
  const parts = routeParts();
  const admin = me.value?.user.instanceAdmin === true;
  if (parts[0] === "o" && parts[1]) return <OrgRoute parts={parts} />;
  if (parts[0] === "account") return <AccountPage />;
  if (parts[0] === "approvals" && canDecideApprovals(me.value)) return <PendingApprovals />;
  if (admin && parts[0] === "agents") return <AgentsPage />;
  if (admin && parts[0] === "search") return <SearchPage />;
  if (admin && parts[0] === "runs" && parts[1]) return <RunPage id={parts[1]} key={parts[1]} />;
  if (admin && (parts[0] === "runs" || parts.length === 0)) return <RunsPage />;
  const slug = selectedSlug();
  return slug ? <OrgRoute parts={["o", slug]} /> : <p class="muted">No organisation yet.</p>;
}

function App(): preact.JSX.Element {
  const parts = routeParts();
  const loggedIn = me.value !== null;
  useEffect(() => {
    if (!me.value && parts[0] !== "login" && parts[0] !== "enroll") {
      refreshMe().catch((err: unknown) => console.error("cannot load the account", err));
    }
  }, [parts[0]]);
  let body: preact.JSX.Element;
  if (parts[0] === "login") body = <LoginPage />;
  else if (parts[0] === "enroll" && parts[1]) body = <EnrollPage code={parts[1]} key={parts[1]} />;
  else body = loggedIn ? <Page /> : <p class="muted">Loading…</p>;
  return (
    <>
      <Header />
      <main>{body}</main>
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err: unknown) => {
    console.warn("service worker not registered", err);
  });
}

// Bun's HTML bundler cannot resolve a manifest href served by the server, so the link is added here.
const manifest = document.createElement("link");
manifest.rel = "manifest";
manifest.href = "/manifest.webmanifest";
document.head.append(manifest);
