import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserData } from "@/actions/user-actions";
import OpenAI from "openai";
import * as XLSX from "xlsx";
import { WebPDFLoader } from "@langchain/community/document_loaders/web/pdf";
import { convertExistingOfferToMyWork } from "@/actions/convert-existing-offer-actions";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: NextRequest) {
  try {
    // Verify authentication
    const userData = await getCurrentUserData();
    if (!userData || !("email" in userData) || !userData.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    let extractedText = "";

    // Extract text based on file type
    if (file.type === "application/pdf") {
      const loader = new WebPDFLoader(file);
      const docs = await loader.load();
      extractedText = docs.map((doc) => doc.pageContent).join("\n\n");
    } else if (
      file.type ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.type === "application/vnd.ms-excel"
    ) {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });

      workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const sheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        extractedText += `\n\n=== ${sheetName} ===\n`;

        sheetData.forEach((row: unknown) => {
          if (Array.isArray(row) && row.length > 0) {
            const rowText = row
              .filter((cell) => cell != null && cell !== "")
              .join(" | ");
            if (rowText.trim()) {
              extractedText += rowText + "\n";
            }
          }
        });
      });
    } else {
      return NextResponse.json(
        { error: "Unsupported file type" },
        { status: 400 },
      );
    }

    if (!extractedText.trim()) {
      return NextResponse.json(
        { error: "No text could be extracted from file" },
        { status: 400 },
      );
    }

    // Use OpenAI to convert the existing offer into structured format
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Te egy építőipari ajánlat feldolgozó AI vagy. A feladatod, hogy egy vállalkozó által készített meglévő ajánlatot strukturált formátumra alakíts.

Az eredménynek JSON formátumban kell lennie az alábbi struktúrával:
{
  "title": "Ajánlat címe (pl. Fürdőszoba felújítás)",
  "location": "Rövid helyszín (pl. Budapest, XI. kerület) - NE teljes cím, csak város és kerület/városrész",
  "customerName": "Ügyfél neve (ha van az ajánlatban, különben üres string)",
  "estimatedTime": "Becsült kivitelezési idő (pl. 2-3 hét, 10-14 nap)",
  "offerSummary": "Rövid összefoglaló az ajánlatról (1-2 mondat)",
  "description": "Részletes leírás a projektről, amit az ajánlat tartalmaz. Ha van pontos cím (pl. utca, házszám), azt ide tedd.",
  "items": [
    {
      "name": "Munka vagy anyag neve",
      "quantity": számadat,
      "unit": "mértékegység (pl. m2, db, óra)",
      "unitPrice": munkadíj egységár számban (ha csak 1 ár van, az legyen itt, materialUnitPrice=0),
      "materialUnitPrice": anyagköltség egységár számban (ha nincs külön anyagár, akkor 0),
      "workTotal": munkadíj összesen (quantity * unitPrice),
      "materialTotal": anyagköltség összesen (quantity * materialUnitPrice),
      "totalPrice": összes ár összesen (workTotal + materialTotal),
      "description": "Opcionális részletes leírás"
    }
  ],
  "totalPrice": teljes ár összesen számban,
  "notes": ["Opcionális megjegyzések tömb"]
}

FONTOS:
- A location csak rövid (város + kerület), pl: "Budapest, XIII. kerület" vagy "Debrecen"
- A pontos címet (utca, házszám) a description-be tedd
- Az items tömbben minden munkát és anyagot fel kell sorolni
- A számokat pontosan számként add meg, ne stringként
- Ha nincs egységár vagy mennyiség, becsüld meg az adatokból
- A title legyen rövid és beszédes
- Az offerSummary 1-2 mondatban foglalja össze mit tartalmaz az ajánlat
- KRITIKUS: Minden item-nél kötelező megadni: unitPrice, materialUnitPrice, workTotal, materialTotal, totalPrice
- Ha az ajánlatban csak 1 ár van (nem különbözik munkadíj/anyagköltség), az unitPrice legyen az ár, materialUnitPrice=0
- workTotal = Math.round(quantity * unitPrice), materialTotal = Math.round(quantity * materialUnitPrice), totalPrice = workTotal + materialTotal
- FONTOS: workTotal, materialTotal és totalPrice MINDIG egész számok legyenek (kerekítve)!

VÉGÖSSZEG SZABÁLY (KRITIKUS!):
- Ha az ajánlatban van "ÖSSZESEN", "ÖSSZESEN NETTÓ", "VÉGÖSSZEG", "TOTAL" vagy hasonló összesítő sor, akkor KÖTELEZŐEN azt az értéket használd a "totalPrice" mezőhöz!
- NE számold újra a végösszeget a tételekből! Az eredeti dokumentumban megadott végösszeg a mérvadó!
- Példa: Ha az Excel-ben "ÖSSZESEN NETTÓ | 413808FT" szerepel, akkor totalPrice: 413808`,
        },
        {
          role: "user",
          content: `Alakítsd át ezt a meglévő ajánlatot strukturált formátumra:\n\n${extractedText}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: "json_object" },
    });

    const aiResponse = completion.choices[0]?.message?.content;
    if (!aiResponse) {
      throw new Error("No response from AI");
    }

    const structuredOffer = JSON.parse(aiResponse);

    // Extract total price from original text if present (override AI calculation)
    // Look for patterns like "ÖSSZESEN NETTÓ | 413808FT" or "VÉGÖSSZEG: 500000"
    const totalPriceMatch = extractedText.match(
      /(?:ÖSSZESEN\s*NETTÓ?|VÉGÖSSZEG|TOTAL|ÖSSZESEN)[:\s|]*(\d[\d\s.,]*)\s*(?:FT|Ft|HUF)?/i,
    );
    if (totalPriceMatch) {
      const extractedTotal = parseInt(
        totalPriceMatch[1].replace(/[\s.,]/g, ""),
        10,
      );
      if (!isNaN(extractedTotal) && extractedTotal > 0) {
        console.log(
          `[convert-existing-offer] Overriding AI totalPrice ${structuredOffer.totalPrice} with extracted value: ${extractedTotal}`,
        );
        structuredOffer.totalPrice = extractedTotal;
      }
    }

    // Use the new server action to create MyWork, Requirement, and Offer
    const result = await convertExistingOfferToMyWork({
      title: structuredOffer.title || "Feltöltött ajánlat",
      location: structuredOffer.location || "",
      customerName: structuredOffer.customerName || "",
      estimatedTime: structuredOffer.estimatedTime || "",
      description: structuredOffer.description || "",
      offerSummary: structuredOffer.offerSummary || "",
      totalPrice: structuredOffer.totalPrice || 0,
      items: structuredOffer.items || [],
      notes: structuredOffer.notes || [],
    });

    return NextResponse.json({
      success: result.success,
      requirementId: result.requirementId,
      offerId: result.offerId,
      myWorkId: result.myWorkId,
    });
  } catch (error) {
    console.error("Error converting existing offer:", error);
    return NextResponse.json(
      {
        error: "Failed to process offer",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
