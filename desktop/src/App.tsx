import React from "react";
import Dashboard from "./Dashboard";

const Sidebar: React.FC = () => {
  const navItems = ["Dashboard", "Routes", "Cache", "Costs", "Settings"];
  return (
    <aside className="w-64 bg-slate-900 text-slate-200 min-h-screen flex flex-col">
      <div className="px-6 py-6 text-xl font-bold border-b border-slate-700">
        AgentFlux
      </div>
      <nav className="flex-1 px-4 py-4 space-y-2">
        {navItems.map((item) => (
          <a
            key={item}
            href="#"
            className="block px-3 py-2 rounded hover:bg-slate-800 transition-colors"
          >
            {item}
          </a>
        ))}
      </nav>
    </aside>
  );
};

const App: React.FC = () => {
  return (
    <div className="flex min-h-screen bg-slate-100">
      <Sidebar />
      <main className="flex-1 p-8">
        <Dashboard />
      </main>
    </div>
  );
};

export default App;
