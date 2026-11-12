import { createFileRoute } from "@tanstack/react-router";

import { OrchestratorPage } from "../components/orchestrator/OrchestratorPage";

export const Route = createFileRoute("/_chat/orchestrator")({
  component: OrchestratorPage,
});
