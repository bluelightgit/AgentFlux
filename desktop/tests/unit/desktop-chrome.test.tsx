import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/AppShell';
import TitleBar from '../../src/components/TitleBar';
import { ThemeProvider } from '../../src/components/ThemeProvider';
import { useDashboardStore } from '../../src/store/dashboard-store';
import { useWorkbenchStore } from '../../src/store/workbench-store';

vi.mock('../../src/hooks/useEventNotifications', () => ({ useEventNotifications: () => {} }));

describe('Desktop workbench chrome', () => {
  beforeEach(() => {
    useDashboardStore.setState({ currentPage: 'workbench', project: null, workspaces: [], activeWorkspace: null, events: [] });
    Object.defineProperty(window, 'api', { configurable: true, value: { platform: 'win32' } });
  });

  it('opens the shared command palette from the title-bar search button', async () => {
    render(<ThemeProvider><AppShell><main>workbench</main></AppShell></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Search and commands' }));
    expect(screen.getByRole('dialog', { name: 'Search and commands' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText('Type a command or search...')).toHaveFocus());
  });

  it('refreshes dashboard and runtime state together', async () => {
    const reload = vi.fn(async () => {});
    const loadRuntimes = vi.fn(async () => {});
    useDashboardStore.setState({ reload });
    useWorkbenchStore.setState({ loadRuntimes });
    render(<ThemeProvider><AppShell><main>workbench</main></AppShell></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(loadRuntimes).toHaveBeenCalledOnce();
  });

  it('uses sender-bound async window controls and reflects maximize state', async () => {
    const minimizeWindow = vi.fn(async () => {});
    const maximizeWindow = vi.fn(async () => true);
    const closeWindow = vi.fn(async () => {});
    Object.defineProperty(window, 'api', { configurable: true, value: {
      platform: 'win32', isMaximized: vi.fn(async () => false), minimizeWindow, maximizeWindow, closeWindow,
    } });
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle maximize window' }));
    await waitFor(() => expect(screen.getByTitle('Restore')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(minimizeWindow).toHaveBeenCalledOnce();
    expect(maximizeWindow).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });
});
