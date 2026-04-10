import { prisma } from "../../lib/data/prisma.js";

/**
 * Extracts possible document references (e.g. INV-2026-0001, PO-2026-0001) from text.
 */
function extractDocumentRefs(text: string): string[] {
  const matches = text.match(/\b(INV|PO|BILL|RCPT)-\d{4}-\d+\b/g);
  return matches ? Array.from(new Set(matches)) : [];
}

export async function validateDocumentReferences(narration: string, tenantId: string) {
  const refs = extractDocumentRefs(narration);
  const hallucinated: string[] = [];
  
  if (refs.length > 0) {
    // Look up the extracted references in the database
    const docs = (prisma as any).document ? await (prisma as any).document.findMany({
      where: {
        tenantId,
        docNumber: { in: refs }
      }
    }) : [];
    
    const validRefs = new Set(docs.map((d: any) => d.docNumber));
    for (const ref of refs) {
      if (!validRefs.has(ref)) {
        hallucinated.push(ref);
      }
    }
  }
  
  return { 
    valid: hallucinated.length === 0, 
    hallucinated 
  };
}
