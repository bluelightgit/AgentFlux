import React from "react";

const PlaceholderCard: React.FC<{ title: string }> = ({ title }) => (
  <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
    <h3 className="text-lg font-semibold text-slate-700 mb-4">{title}</h3>
    <div className="h-48 flex items-center justify-center text-slate-400 border border-dashed border-slate-300 rounded">
      Chart placeholder
    </div>
  </div>
);

const Dashboard: React.FC = () => {
  return (
    <div>
      <h1 className="text-3xl font-bold text-slate-800 mb-8">
        AgentFlux Dashboard
      </h1>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <PlaceholderCard title="Route Map" />
        <PlaceholderCard title="Cache Chart" />
        <PlaceholderCard title="Cost Breakdown" />
      </div>
    </div>
  );
};

export default Dashboard;
