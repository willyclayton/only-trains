import { Suspense } from "react";
import Planner from "@/components/Planner";

export default function Page() {
  return (
    <Suspense>
      <Planner />
    </Suspense>
  );
}
