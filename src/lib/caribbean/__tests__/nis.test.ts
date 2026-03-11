import { describe, it, expect } from "vitest";
import { calculateNis, calculateNisAnnual, calculateNisBatch } from "../nis.js";
import { NIS_EMPLOYER_RATE, NIS_EMPLOYEE_RATE, NIS_CEILING } from "../constants.js";

describe("NIS Engine", () => {
  describe("constants", () => {
    it("has correct NIS rates", () => {
      expect(NIS_EMPLOYER_RATE).toBe(0.088);
      expect(NIS_EMPLOYEE_RATE).toBe(0.056);
      expect(NIS_CEILING).toBe(280_000);
    });
  });

  describe("calculateNis", () => {
    it("calculates NIS below ceiling", () => {
      const result = calculateNis(200_000);
      expect(result.insurableEarnings).toBe(200_000);
      expect(result.employeeContribution).toBe(11_200); // 200k × 0.056
      expect(result.employerContribution).toBe(17_600); // 200k × 0.088
      expect(result.totalContribution).toBe(28_800);
      expect(result.ceilingApplied).toBe(false);
    });

    it("caps insurable earnings at ceiling", () => {
      const result = calculateNis(500_000);
      expect(result.insurableEarnings).toBe(280_000); // Capped
      expect(result.employeeContribution).toBe(15_680); // 280k × 0.056
      expect(result.employerContribution).toBe(24_640); // 280k × 0.088
      expect(result.ceilingApplied).toBe(true);
    });

    it("handles salary exactly at ceiling", () => {
      const result = calculateNis(280_000);
      expect(result.insurableEarnings).toBe(280_000);
      expect(result.ceilingApplied).toBe(false); // Not exceeded
    });

    it("handles zero salary", () => {
      const result = calculateNis(0);
      expect(result.insurableEarnings).toBe(0);
      expect(result.employeeContribution).toBe(0);
      expect(result.employerContribution).toBe(0);
      expect(result.totalContribution).toBe(0);
    });

    it("handles minimum wage scenario", () => {
      const result = calculateNis(60_000);
      expect(result.employeeContribution).toBe(3_360);  // 60k × 0.056
      expect(result.employerContribution).toBe(5_280);  // 60k × 0.088
    });

    it("supports custom ceiling override", () => {
      const result = calculateNis(200_000, 150_000);
      expect(result.insurableEarnings).toBe(150_000);
      expect(result.ceilingApplied).toBe(true);
      expect(result.ceiling).toBe(150_000);
    });

    it("returns the ceiling value", () => {
      const result = calculateNis(100_000);
      expect(result.ceiling).toBe(280_000);
    });
  });

  describe("calculateNisAnnual", () => {
    it("calculates 12-month annual summary", () => {
      const monthlySalaries = Array(12).fill(200_000);
      const result = calculateNisAnnual(monthlySalaries);

      expect(result.months).toBe(12);
      expect(result.totalEmployeeContributions).toBe(134_400); // 11,200 × 12
      expect(result.totalEmployerContributions).toBe(211_200); // 17,600 × 12
      expect(result.totalContributions).toBe(345_600);
    });

    it("handles variable monthly salaries (bonus months)", () => {
      const salaries = [
        ...Array(11).fill(200_000),
        400_000, // December bonus month
      ];
      const result = calculateNisAnnual(salaries);

      // 11 months × 11,200 + 1 month × 15,680 (capped at 280k)
      expect(result.totalEmployeeContributions).toBe(138_880);
      expect(result.months).toBe(12);
    });

    it("handles mid-year hire (partial year)", () => {
      const salaries = Array(6).fill(200_000); // Hired in July
      const result = calculateNisAnnual(salaries);

      expect(result.months).toBe(6);
      expect(result.totalEmployeeContributions).toBe(67_200); // 11,200 × 6
    });

    it("handles empty array", () => {
      const result = calculateNisAnnual([]);
      expect(result.months).toBe(0);
      expect(result.totalContributions).toBe(0);
    });
  });

  describe("calculateNisBatch", () => {
    it("processes multiple employees", () => {
      const result = calculateNisBatch([
        { id: "emp-1", name: "Alice", grossMonthly: 200_000 },
        { id: "emp-2", name: "Bob", grossMonthly: 350_000 },
        { id: "emp-3", name: "Charlie", grossMonthly: 100_000 },
      ]);

      expect(result.results).toHaveLength(3);
      expect(result.results[0]!.id).toBe("emp-1");
      expect(result.results[0]!.name).toBe("Alice");
      expect(result.results[0]!.employeeContribution).toBe(11_200);

      // Bob is capped at ceiling
      expect(result.results[1]!.ceilingApplied).toBe(true);
      expect(result.results[1]!.insurableEarnings).toBe(280_000);

      // Batch totals
      expect(result.batchTotalEmployee).toBe(
        11_200 + 15_680 + 5_600
      );
      expect(result.batchTotalEmployer).toBe(
        17_600 + 24_640 + 8_800
      );
    });

    it("handles single employee batch", () => {
      const result = calculateNisBatch([
        { id: "emp-1", name: "Solo", grossMonthly: 250_000 },
      ]);

      expect(result.results).toHaveLength(1);
      expect(result.batchTotal).toBe(result.batchTotalEmployee + result.batchTotalEmployer);
    });

    it("handles empty batch", () => {
      const result = calculateNisBatch([]);
      expect(result.results).toHaveLength(0);
      expect(result.batchTotal).toBe(0);
    });
  });
});
