import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppFrame, Badge, Card, DataTable } from "../../src/components/ui";

describe("Desktop visual system primitives", () => {
  it("applies the shared industrial panel and badge contracts", () => {
    render(<Card data-testid="panel"><Badge>ready</Badge></Card>);
    expect(screen.getByTestId("panel")).toHaveClass("af-panel");
    expect(screen.getByText("ready")).toHaveClass("af-badge");
  });

  it("uses the compact shared data table contract", () => {
    const { container } = render(<DataTable columns={[{ key: "name", label: "Agent" }]} rows={[{ name: "worker" }]} />);
    expect(container.querySelector("table")).toHaveClass("af-data-table");
    expect(screen.getByRole("columnheader", { name: "Agent" })).toHaveClass("font-mono");
  });

  it("keeps the shell on the shared control-plane frame contract", () => {
    render(<AppFrame><main>workspace</main></AppFrame>);
    expect(screen.getByTestId("agentflux-app-frame")).toHaveClass("af-app", "h-screen", "overflow-hidden");
  });
});
