export const SEARCH_FILE_COUNT = 25000;
export const TOPICS = [
  "astronomy telescope nebula",
  "botanical garden orchids",
  "financial revenue forecast",
  "maritime sailing navigation",
  "volcanic geology basalt",
  "culinary baking sourdough",
  "musical violin concerto",
  "architecture urban bridges",
  "medical anatomy skeleton",
  "mathematical algebra equations",
  "historical medieval castles",
  "photography camera exposure",
  "programming compiler optimization",
  "ecology wetland restoration",
  "aeronautical aircraft wings",
  "literature poetry sonnet",
  "chemistry molecular reactions",
  "logistics warehouse inventory",
  "ceramics pottery glazing",
  "textiles weaving patterns",
  "oceanography coral currents",
  "meteorology rainfall climate",
  "agriculture wheat harvest",
  "cycling bicycle maintenance",
  "painting watercolor landscape",
  "robotics sensors automation",
  "education classroom curriculum",
  "energy solar batteries",
  "language translation Swedish",
  "sports climbing training",
  "travel railway journey",
  "wildlife birds migration",
] as const;
export function searchDocument(index: number) {
  const topic = TOPICS[index % TOPICS.length];
  if (topic === undefined || !Number.isInteger(index) || index < 0)
    throw Error("Invalid document index");
  const key = topic.split(" ")[0];
  return {
    name: `${key}-${String(index).padStart(5, "0")}.txt`,
    text: `Research report on ${topic}. This document describes practical observations, detailed methods and project outcomes for the ${key} team. Årsrapport och internationella resultat.`,
    topic,
  };
}
export function validateVector(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 384 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    throw Error("TEI did not return a finite384-dimensional vector");
  return value as number[];
}
