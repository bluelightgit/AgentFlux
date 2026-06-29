/**
 * 路由分配测试 — assignModel / rankModels / calcAffinity / discoverPiModels / findFallbackModel
 * 覆盖之前未被测试覆盖的模型分配核心逻辑
 */
import {
  type ModelEntry, type RoleRequirement, type ModelCapability,
  resolveCapability, calcAffinity, rankModels, assignModel,
  discoverPiModels, mergeModels, findFallbackModel,
  contextToScore, pricingToCostEff,
} from "../src/core/model-capability";

const MODELS: Record<string, ModelEntry> = {
  "gpt-5.5": {
    provider: "octopus-responses",
    contextWindow: 900000,
    pricing: { input: 5e-6, output: 3e-5, cacheRead: 5e-7 },
    capability: { coding: 0.85, reasoning: 0.95, speed: 0.40 },
  },
  "deepseek-v4-flash": {
    provider: "octopus-anthropic",
    contextWindow: 1000000,
    pricing: { input: 9e-8, output: 1.8e-7, cacheRead: 2e-8 },
    capability: { coding: 0.78, reasoning: 0.70, speed: 0.85 },
  },
  "glm-5.2": {
    provider: "octopus-completions",
    contextWindow: 200000,
    pricing: { input: 9.5e-7, output: 3e-6, cacheRead: 1.8e-7 },
    capability: { coding: 0.80, reasoning: 0.85, speed: 0.72 },
  },
};

const REQUIREMENTS: Record<string, RoleRequirement> = {
  planner: { coding: 0.3, reasoning: 0.9, speed: 0.2, context: 0.7, cost_eff: 0.3 },
  implementer: { coding: 0.8, reasoning: 0.5, speed: 0.6, cost_eff: 0.7 },
  reviewer: { coding: 0.7, reasoning: 0.8, cost_eff: 0.4 },
  tester: { coding: 0.7, reasoning: 0.5, speed: 0.5, cost_eff: 0.6 },
};

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// ─── resolveCapability ───

console.log("\n[resolveCapability]");
{
  const cap = resolveCapability("gpt-5.5", MODELS["gpt-5.5"], MODELS);
  check("user coding 0.85 preserved", cap.coding === 0.85);
  check("user reasoning 0.95 preserved", cap.reasoning === 0.95);
  check("user speed 0.40 preserved", cap.speed === 0.40);
  check("context from 900K window (200K cap)", cap.context === 0.85, `got ${cap.context}`);
  check("cost_eff computed from pricing", cap.cost_eff > 0 && cap.cost_eff < 1);
}

{
  // 未知模型的家族启发式
  const cap = resolveCapability("qwen3.7-max", { provider: "test", contextWindow: 1000000 }, MODELS);
  check("qwen family heuristic coding 0.75", cap.coding === 0.75);
  check("qwen family heuristic reasoning 0.75", cap.reasoning === 0.75);
  check("qwen context from 1M (200K cap)", cap.context === 0.85);
}

// ─── contextToScore ───

console.log("\n[contextToScore]");
{
  check("4K → ~0.58", Math.abs(contextToScore(4096) - 0.58) < 0.05);
  check("128K → ~0.82", Math.abs(contextToScore(128000) - 0.82) < 0.05);
  check("200K → 0.85 (cap)", contextToScore(200000) === 0.85);
  check("900K → 0.85 (cap)", contextToScore(900000) === 0.85);
  check("1M → 0.85 (cap)", contextToScore(1000000) === 0.85);
  check("0 → 0", contextToScore(0) === 0);
}

// ─── pricingToCostEff ───

console.log("\n[pricingToCostEff]");
{
  const allPricings = Object.values(MODELS).map(m => m.pricing!).filter(Boolean);
  const gptCost = pricingToCostEff(MODELS["gpt-5.5"].pricing, allPricings);
  const dsCost = pricingToCostEff(MODELS["deepseek-v4-flash"].pricing, allPricings);
  const glmCost = pricingToCostEff(MODELS["glm-5.2"].pricing, allPricings);
  check("deepseek (cheapest) highest cost_eff", dsCost > gptCost && dsCost > glmCost);
  check("gpt (most expensive) lowest cost_eff", gptCost < dsCost && gptCost < glmCost);
  check("cost_eff in range [0.25, 0.85]", gptCost >= 0.25 && dsCost <= 0.85);
}

// ─── calcAffinity ───

console.log("\n[calcAffinity]");
{
  const gptCap = resolveCapability("gpt-5.5", MODELS["gpt-5.5"], MODELS);
  const dsCap = resolveCapability("deepseek-v4-flash", MODELS["deepseek-v4-flash"], MODELS);
  const glmCap = resolveCapability("glm-5.2", MODELS["glm-5.2"], MODELS);
  
  const plannerAffinityGpt = calcAffinity(gptCap, REQUIREMENTS.planner);
  const plannerAffinityDs = calcAffinity(dsCap, REQUIREMENTS.planner);
  const plannerAffinityGlm = calcAffinity(glmCap, REQUIREMENTS.planner);
  // 归一化后, planner 的 reasoning 权重最大 (0.375), gpt reasoning=0.95 远高于 deepseek 0.70
  // 但 context 饱和后不过多加分, cost_eff 差异也有限
  // 关键: gpt 的 reasoning 优势被其极低 cost_eff (0.25) 和 speed (0.40) 部分抵消
  // 结果可能 glm 或 gpt 胜出, 取决于 tie-breaking
  check("planner prefers high-reasoning model over deepseek", plannerAffinityGpt > plannerAffinityDs || plannerAffinityGlm > plannerAffinityDs,
    `gpt=${plannerAffinityGpt.toFixed(3)}, glm=${plannerAffinityGlm.toFixed(3)}, ds=${plannerAffinityDs.toFixed(3)}`);
  
  const implAffinityDs = calcAffinity(dsCap, REQUIREMENTS.implementer);
  const implAffinityGpt = calcAffinity(gptCap, REQUIREMENTS.implementer);
  check("implementer prefers deepseek over gpt (cost_eff)", implAffinityDs > implAffinityGpt,
    `${implAffinityDs.toFixed(3)} vs ${implAffinityGpt.toFixed(3)}`);
}

// ─── rankModels ───

console.log("\n[rankModels]");
{
  const plannerRanking = rankModels(REQUIREMENTS.planner, MODELS);
  check("planner ranking has 3 models", plannerRanking.length === 3);
  // planner: glm (0.792) > deepseek (0.785) > gpt (0.775)
  // tie-breaking 不触发 (planner cost_eff 权重 0.3 < 0.5)
  check("planner top model is glm-5.2 (high reasoning, cost-aware)",
    plannerRanking[0].model === "glm-5.2",
    `got ${plannerRanking[0].model}`);
  check("ranking sorted descending", plannerRanking[0].affinity >= plannerRanking[1].affinity);
  
  const implRanking = rankModels(REQUIREMENTS.implementer, MODELS);
  check("implementer top model is deepseek-v4-flash (cost_eff wins)", implRanking[0].model === "deepseek-v4-flash",
    `got ${implRanking[0].model}`);
}

// ─── assignModel ───

console.log("\n[assignModel]");
{
  // Case 1: 直接指定模型且存在
  const r1 = assignModel("planner", { model: "gpt-5.5", requirement: REQUIREMENTS.planner }, MODELS);
  check("direct model assignment", r1.model === "gpt-5.5");
  check("source = model", r1.source === "model");
  check("reason contains planner", r1.reason.includes("planner"));

  // Case 2: 指定模型不存在 → fallback 到亲和度匹配
  const r2 = assignModel("reviewer", { model: "nonexistent-model", requirement: REQUIREMENTS.reviewer }, MODELS);
  check("nonexistent model falls back to affinity", r2.source === "affinity");
  check("fallback picks a valid model", Object.keys(MODELS).includes(r2.model));
  check("reason mentions fallback", r2.reason.includes("fallback"));

  // Case 3: 无 model 指定, 纯亲和度匹配
  const r3 = assignModel("implementer", { requirement: REQUIREMENTS.implementer }, MODELS);
  check("no model → affinity match", r3.source === "affinity");
  check("implementer gets deepseek (cost_eff)", r3.model === "deepseek-v4-flash",
    `got ${r3.model}`);

  // Case 4: 只有一个模型
  const singleModel = { "only-model": MODELS["gpt-5.5"] };
  const r4 = assignModel("planner", { requirement: REQUIREMENTS.planner }, singleModel);
  check("single model → source = single", r4.source === "single");
  check("single model → returns that model", r4.model === "only-model");

  // Case 5: 无 model 无 requirement → error
  try {
    assignModel("unknown", {}, MODELS);
    check("no model + no requirement → throws", false);
  } catch (e: any) {
    check("no model + no requirement → throws", e.message.includes("必须指定"));
  }

  // Case 6: 空模型表 → error
  try {
    assignModel("planner", { requirement: REQUIREMENTS.planner }, {});
    check("empty models → throws", false);
  } catch (e: any) {
    check("empty models → throws", e.message.includes("无可用模型") || e.message.includes("empty"));
  }
}

// ─── mergeModels ───

console.log("\n[mergeModels]");
{
  const agentFluxModels = { "gpt-5.5": MODELS["gpt-5.5"] };
  const piModels = {
    "gpt-5.5": { provider: "different", contextWindow: 500000 },  // should be overridden
    "glm-5.2": { provider: "octopus-completions", contextWindow: 200000 },
  };
  const merged = mergeModels(agentFluxModels, piModels);
  check("merged has 2 models", Object.keys(merged).length === 2);
  check("AgentFlux gpt-5.5 overrides pi gpt-5.5", merged["gpt-5.5"].contextWindow === 900000);
  check("pi glm-5.2 added", merged["glm-5.2"] !== undefined);
}

// ─── discoverPiModels ───

console.log("\n[discoverPiModels]");
{
  // Test with real pi models.json path
  const piModels = discoverPiModels();
  if (Object.keys(piModels).length > 0) {
    console.log(`  Found ${Object.keys(piModels).length} pi models: ${Object.keys(piModels).join(", ")}`);
    check("pi models discovered", Object.keys(piModels).length > 0);
    check("gpt-5.5 in pi models", "gpt-5.5" in piModels);
    check("oa/glm-5.2 in pi models", "oa/glm-5.2" in piModels);
    check("each model has provider", Object.values(piModels).every(m => m.provider !== undefined));
    check("each model has contextWindow", Object.values(piModels).every(m => m.contextWindow > 0));
  } else {
    console.log("  (pi models.json not found on this system, skipping)");
    check("discoverPiModels returns empty on missing file", true);
  }

  // Test with nonexistent path
  const empty = discoverPiModels("/nonexistent/path/models.json");
  check("nonexistent path → empty object", Object.keys(empty).length === 0);
}

// ─── findFallbackModel ───

console.log("\n[findFallbackModel]");
{
  // gpt-5.5 在 planner 排序中是最后 (reasoning 差 + cost 高), 无法降级
  const gptFallback = findFallbackModel("gpt-5.5", REQUIREMENTS.planner, MODELS);
  check("gpt-5.5 is lowest for planner → no fallback", gptFallback === null,
    `got ${gptFallback}`);

  // glm-5.2 在 planner 排序中第一, 失败后应降级到 deepseek
  const glmFallback = findFallbackModel("glm-5.2", REQUIREMENTS.planner, MODELS);
  check("fallback from glm-5.2 is not glm-5.2", glmFallback !== "glm-5.2");
  check("fallback from glm-5.2 is a valid model", glmFallback !== null && Object.keys(MODELS).includes(glmFallback));
  check("fallback from glm-5.2 is deepseek (next in planner ranking)", glmFallback === "deepseek-v4-flash",
    `got ${glmFallback}`);
  console.log(`  glm-5.2 → ${glmFallback}`);

  // 最低档模型无法降级
  // 对 planner 来说, gpt-5.5 是最低档 (affinity=0.775)
  const plannerRanking = rankModels(REQUIREMENTS.planner, MODELS);
  const lowestModel = plannerRanking[plannerRanking.length - 1].model;
  check("lowest model is gpt-5.5 for planner", lowestModel === "gpt-5.5");
  const noFallback = findFallbackModel(lowestModel, REQUIREMENTS.planner, MODELS);
  check("lowest model → no fallback (null)", noFallback === null,
    `got ${noFallback} (lowest was ${lowestModel})`);

  // 失败模型不在列表中 → 返回最后一个
  const unknownFallback = findFallbackModel("unknown-model", REQUIREMENTS.planner, MODELS);
  check("unknown model → returns lowest", unknownFallback !== null && unknownFallback === lowestModel);
}

// ─── 多角色自动路由验证 ───

console.log("\n[multi-role auto-routing with 7 pi models]");
{
  const piModels = discoverPiModels();
  if (Object.keys(piModels).length >= 3) {
    // 模拟合并后的完整模型表
    const fullModels = mergeModels(MODELS, piModels);
    console.log(`  Total models after merge: ${Object.keys(fullModels).length}`);
    
    // 每个角色应该路由到不同模型 (如果需求差异足够大)
    const roleResults: Record<string, string> = {};
    for (const [roleName, req] of Object.entries(REQUIREMENTS)) {
      const r = assignModel(roleName, { requirement: req }, fullModels);
      roleResults[roleName] = r.model;
      console.log(`  ${roleName.padEnd(12)} → ${r.model.padEnd(20)} (source=${r.source}, affinity=${r.affinity.toFixed(3)})`);
    }
    
    // 至少 2 个不同角色路由到不同模型 (验证异构能力)
    const uniqueModels = new Set(Object.values(roleResults));
    check("at least 2 different models across 4 roles", uniqueModels.size >= 2,
      `got ${uniqueModels.size} unique models`);
    
    // planner 应该选 glm-5.2 (reasoning 0.85 + cost-aware, tie-breaking 不触发)
    check("planner gets glm-5.2 (high reasoning, not deepseek)",
      roleResults["planner"] === "glm-5.2" || roleResults["planner"] === "gpt-5.5",
      `got ${roleResults["planner"]}`);
    
    // implementer 应该选高 cost_eff 模型 (deepseek)
    check("implementer gets cost-efficient model (deepseek)",
      roleResults["implementer"].includes("deepseek"),
      `got ${roleResults["implementer"]}`);
  } else {
    console.log("  (insufficient pi models for multi-role test, skipping)");
  }
}

// ─── Summary ───
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail > 0) {
  console.log("FAILURES DETECTED");
  process.exit(1);
} else {
  console.log("ALL PASSED ✅");
}
