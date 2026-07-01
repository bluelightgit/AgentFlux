/**
 * RoutingFlowDiagram — static educational diagram of the 3-tier
 * routing decision architecture (L1 / L2 / L3 signals).
 *
 * Layer 1 (Static)   : Task structure signals     — zero LLM cost, blue
 * Layer 2 (Budget)   : ILP/heuristic model select — zero LLM cost, amber
 * Layer 3 (RL)       : Experience routing         — requires telemetry, green
 * Output             : Route Decision             — purple
 */
import React from "react";
import { Card, Icon } from "./ui";

/** A single labeled box in the flow diagram. */
interface FlowBoxProps {
  label: string;
  subtext: string;
  /** Full Tailwind class fragment for the colored box. */
  boxClass: string;
  /** Tailwind class for the accent text (title). */
  titleClass: string;
}

const FlowBox: React.FC<FlowBoxProps> = ({ label, subtext, boxClass, titleClass }) => (
  <div className={`${boxClass} rounded-lg border-2 p-3 text-center`}>
    <div className={`text-sm font-semibold ${titleClass}`}>{label}</div>
    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{subtext}</div>
  </div>
);

/** Vertical connector with a chevron icon. */
const Arrow: React.FC = () => (
  <div className="flex justify-center py-1 text-slate-400 dark:text-slate-500">
    <Icon name="ChevronDown" size={20} />
  </div>
);

/** Side annotation pill. */
interface AnnotationProps {
  text: string;
  color: string;
}

const Annotation: React.FC<AnnotationProps> = ({ text, color }) => (
  <span className={`text-[10px] font-medium ${color} whitespace-nowrap`}>
    {text}
  </span>
);

export function RoutingFlowDiagram(): React.ReactElement {
  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Workflow" size={18} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-base font-semibold text-slate-700 dark:text-slate-200">
          Routing Decision Flow
        </h3>
      </div>

      {/* Diagram body — each row is a flex pair of (box, annotation). */}
      <div className="flex flex-col">
        {/* L1 */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <FlowBox
              label="L1: Task Structure Signals"
              subtext="RGAO complexity vectors, zero LLM cost"
              boxClass="bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
              titleClass="text-blue-700 dark:text-blue-300"
            />
          </div>
          <Annotation text="Cold start: L1 only" color="text-blue-600 dark:text-blue-400" />
        </div>
        <Arrow />
        {/* L2 */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <FlowBox
              label="L2: Budget Constraints"
              subtext="ILP/heuristic model selection, zero LLM cost"
              boxClass="bg-amber-50 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700"
              titleClass="text-amber-700 dark:text-amber-300"
            />
          </div>
          <Annotation text="Progressive unlock" color="text-amber-600 dark:text-amber-400" />
        </div>
        <Arrow />
        {/* L3 */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <FlowBox
              label="L3: Experience Routing"
              subtext="RL over historical data, requires telemetry"
              boxClass="bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700"
              titleClass="text-green-700 dark:text-green-300"
            />
          </div>
          <Annotation text="Progressive unlock" color="text-green-600 dark:text-green-400" />
        </div>
        <Arrow />
        {/* Output */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <FlowBox
              label="Route Decision: Mode + Model + Thinking"
              subtext="Resolved routing target for the request"
              boxClass="bg-purple-50 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700"
              titleClass="text-purple-700 dark:text-purple-300"
            />
          </div>
          <Annotation text="Final output" color="text-purple-600 dark:text-purple-400" />
        </div>
      </div>

      {/* Legend footer */}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span><span className="font-semibold text-blue-600 dark:text-blue-400">L1</span> Static signals</span>
        <span><span className="font-semibold text-amber-600 dark:text-amber-400">L2</span> Budget solver</span>
        <span><span className="font-semibold text-green-600 dark:text-green-400">L3</span> RL policy</span>
      </div>
    </Card>
  );
}

export default RoutingFlowDiagram;
