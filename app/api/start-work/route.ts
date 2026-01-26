import { NextRequest, NextResponse } from "next/server";
import { ParsedWork, WorkItem } from "@/types/work";
import { currentUser } from "@clerk/nextjs/server";

export async function POST(req: NextRequest) {
  console.log("\n🚀 [start-work] API endpoint called");
  let workId: number | undefined;
  try {
    // ✅ SECURITY: Check authentication
    const user = await currentUser();
    if (!user) {
      console.log("❌ [start-work] Unauthorized - no user");
      return NextResponse.json(
        { error: "Unauthorized - Login required" },
        { status: 401 }
      );
    }
    console.log(
      "✅ [start-work] User authenticated:",
      user.emailAddresses[0]?.emailAddress
    );

    const body = await req.json();
    const parsedBody = body as { workId?: number; location: string; offerDescription: string; estimatedDuration: string; offerItems: WorkItem[] };
    workId = parsedBody.workId;
    const { location, offerDescription, estimatedDuration, offerItems } = parsedBody;
    console.log("📦 [start-work] Request body:", {
      location,
      offerDescription: offerDescription?.substring(0, 100) + "...",
      estimatedDuration,
      offerItemsCount: offerItems?.length,
    });

    if (!location || !offerDescription || !estimatedDuration || !offerItems) {
      console.log("❌ [start-work] Missing required fields:", {
        hasLocation: !!location,
        hasOfferDescription: !!offerDescription,
        hasEstimatedDuration: !!estimatedDuration,
        hasOfferItems: !!offerItems,
      });
      return NextResponse.json(
        { error: "Hiányzó mezők a kérésben." },
        { status: 400 }
      );
    }
    console.log("✅ [start-work] All required fields present");

    // Create the OpenAI prompt
    const prompt = `A következő információk alapján hozz létre egy részletes munkafelosztást ÉRVÉNYES JSON formátumban, az alábbi SZIGORÚ szabályokkal:

    Általános elv:
    - Minden workItem KÖTELEZŐEN tartalmazza: description (1–3 mondat), requiredProfessionals (>=1), tools (nem üres string), materials (>=1).
    - TILOS üres stringet, üres tömböt, "N/A", "-", "none" stb. helykitöltőt használni.
    - Minden szám mező pozitív; minden "type" és "unit" nem üres string.
    - Ha bármelyik kötelező mező üres lenne, NE add vissza a választ – addig állítsd össze, míg MIND megfelel.
    
    FONTOS: Adj hozzá egy "workSummary" mezőt is, ami PONTOSAN 4 mondatból áll és összefoglalja a teljes munkát!
    
    OfferItem átvétel:
    - A következő mezőket VÁLTOZTATÁS NÉLKÜL MÁSOLD át az offerItem-ből a workItem-be:
      name, quantity, unit, unitPrice, materialUnitPrice, workTotal, materialTotal, totalPrice
    
    Csak az alábbi mezőket generáld:
    - workSummary: PONTOSAN 4 mondat a teljes munka összefoglalása
    - description: rövid szakmai leírás (1–3 mondat)
    - requiredProfessionals: objektumok tömbje, MIND: { "type": string!=üres, "quantity": number>0 }
    - A requiredProfessionals mező egy objektumokból álló tömb, amelynek minden eleme KÉT KULCSOT tartalmaz: "type" és "quantity".
    - A "type" mezőbe KIZÁRÓLAG az alábbi lista szakmáit használd: 'kőműves', 'burkoló', 'villanyszerelő', 'vízvezetékszerelő', 'gázszerelő', 'festő', 'ács', 'asztalos', 'gipszkartonozó', 'földmunkagép-kezelő', 'építésvezető', 'építőmérnök', 'statikus', 'hegesztő', 'bádogos', 'tetőfedő', 'szigetelő', 'kertépítő', 'díszburkoló', 'lakatos', 'homlokzati-szakember', 'belsőépítész', 'gépszerelő', 'Darukezelő', 'kőfaragó', 'takarító', 'segédmunkás', 'tartószerkezet-tervező mérnök', 'gépészmérnök', 'villamosmérnök'. TILOS bármilyen más, a listán nem szereplő szakmát megadni.
    - tools: részletes eszközlista szövegként (nem üres)
    - materials: objektumok tömbje, MIND: { "type": string!=üres, "quantity": number>0, "unit": string!=üres }
    - ⚠️ KRITIKUS SZABÁLY - MATERIALS MEZŐHÖZ:
      * A materials[].type mezőben KIZÁRÓLAG BESZERZÉSI/WEBSHOPOS TERMÉKNEVEKET használj!
      * HELYES példák: "cement", "homok", "tégla", "csempe", "festék", "alapozó", "szigetelő lemez", "PVC cső", "gipszkarton lap", "csavar", "betonacél"
      * TILOS példák: "bontási hulladék", "törmelék", "sitt", "munkaerő", "szállítás", "hulladékgyűjtő zsák" - ezek NEM beszerezhető építőanyagok!
      * Ha egy workItem-hez nincs beszerezhető anyag (pl. takarítás, bontás, hulladékszállítás), akkor NE adj hozzá materials elemet, vagy adj hozzá üres tömböt: []

    Kimeneti formátum:
    - CSAK ÉRVÉNYES JSON, semmi magyarázat, semmi markdown.
    
    Bemenet:
    Helyszín: ${location}
    Leírás: ${offerDescription}
    Becsült időtartam: ${estimatedDuration}
    
    Tételek (offerItems):
    ${JSON.stringify(offerItems, null, 2)}
    
    Válasz JSON váz:
    {
      "location": "helyszín",
      "description": "leírás",
      "estimatedDuration": "időtartam",
      "workSummary": "PONTOSAN 2 mondat a teljes munka összefoglalása. Első mondat a projekt célja. Második mondat a főbb munkafázisok.",
      "workItems": [
        {
          "name": "Tétel neve",
          "quantity": <number | string>,
          "unit": "mértékegység",
          "unitPrice": <number | string>,
          "materialUnitPrice": <number | string>,
          "workTotal": <number | string>,
          "materialTotal": <number | string>,
          "totalPrice": <number | string>,
          "description": "rövid szakmai leírás",
          "requiredProfessionals": [
            { "type": "szakember típusa", "quantity": <number> }
          ],
          "tools": "részletes eszközlista",
          "materials": [
            { "type": "anyag típusa", "quantity": <number>, "unit": "mértékegység" }
          ]
        }
      ]
    }
    
    Megjegyzés:
    - MINDEN workItem-hez legalább 1 szakember kötelező. A tools NEM lehet üres.
    - Materials: CSAK beszerezhető építőanyagokat adj meg! Ha nincs beszerezhető anyag (pl. bontás, takarítás), akkor üres tömb: []
    - A fenti átvett mezők értékeinek pontosan egyezniük kell az offerItem megfelelő értékeivel.
    - NE írj magyarázatot, NE használj markdown-t, CSAK ÉRVÉNYES JSON-t adj vissza!
    - Minden workItem a hozzá tartozó offerItem-ből jöjjön létre, a fenti szabályok betartásával! description-t mindig generálj!`;

    // Server-side timeout: 120 seconds (independent of client)
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log("⏱️ [start-work] 120 second server timeout - aborting OpenAI request");
      abortController.abort();
    }, 120000); // 120 seconds

    // Make the OpenAI API request
    console.log("🤖 [start-work] Calling OpenAI API...");
    let openaiResponse;
    try {
      openaiResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: "Te egy profi magyar építési projektmenedzser vagy.",
              },
              { role: "user", content: prompt },
            ],
            max_tokens: 10000, // LIMITÁLT, hogy ne legyen túl hosszú a válasz
            temperature: 0.2,
          }),
          signal: abortController.signal,
        }
      );
      clearTimeout(timeoutId); // Clear timeout if request completes
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === "AbortError") {
        console.log("⏱️ [start-work] Request aborted due to 120s timeout");
        return NextResponse.json(
          { error: "A kérés túllépte a 120 másodperces időkorlátot." },
          { status: 408 }
        );
      }
      throw fetchError; // Re-throw other errors
    }

    // Extract the response data
    console.log(
      "📥 [start-work] OpenAI response status:",
      openaiResponse.status
    );
    const data = await openaiResponse.json();
    const content: string = data.choices?.[0]?.message?.content ?? "";
    console.log("📝 [start-work] OpenAI content length:", content.length);
    console.log(
      "📝 [start-work] OpenAI content preview:",
      content.substring(0, 200) + "..."
    );

    const cleaned = content
      .trim()
      .replace(/^```json[\r\n]*/i, "")
      .replace(/^```[\r\n]*/i, "")
      .replace(/```$/, "")
      .trim();

    let parsed: ParsedWork | null = null;

    console.log("🔍 [start-work] Attempting to parse JSON...");
    try {
      parsed = JSON.parse(cleaned);
      console.log("✅ [start-work] JSON parsed successfully");
      console.log(
        "📊 [start-work] Parsed workItems count:",
        parsed?.workItems?.length
      );
    } catch (jsonErr) {
      console.log(
        "⚠️ [start-work] Initial JSON parse failed, trying regex fallback..."
      );
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
          console.log("✅ [start-work] JSON parsed with regex fallback");
        } catch (innerErr) {
          console.log("❌ [start-work] Regex fallback also failed:", innerErr);
          return NextResponse.json(
            {
              error:
                "OpenAI válasz nem volt JSON (regex fallback sem sikerült).",
              rawContent: content,
              openaiRaw: data,
              details:
                innerErr instanceof Error ? innerErr.message : String(innerErr),
            },
            { status: 400 }
          );
        }
      } else {
        console.log("❌ [start-work] No JSON found in response");
        return NextResponse.json(
          {
            error:
              "OpenAI válasz nem volt JSON (sem sima, sem regex fallback).",
            rawContent: content,
            openaiRaw: data,
            details:
              jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
          },
          { status: 400 }
        );
      }
    }

    // --- Validáció: ellenőrizzük, hogy minden offerItem-hez van workItem ---
    // Majd az eredeti offer értékeket használjuk (az AI csak a description, tools, materials, requiredProfessionals mezőket generálja)
    console.log("🔍 [start-work] Starting validation and merging...");
    console.log("🔍 [start-work] offerItems count:", offerItems?.length);
    console.log("🔍 [start-work] parsed.workItems count:", parsed?.workItems?.length);

    if (
      parsed &&
      Array.isArray(parsed.workItems) &&
      Array.isArray(offerItems)
    ) {
      console.log("✅ [start-work] Validation arrays are valid");

      // Az AI-tól kapott workItems-et mergeljük az eredeti offer értékekkel
      // Az offer értékek mindig felülírják az AI által generáltakat (ár mezők)
      for (let i = 0; i < offerItems.length; i++) {
        console.log(`🔍 [start-work] Processing item ${i + 1}/${offerItems.length}: ${offerItems[i]?.name}`);
        const offer = offerItems[i];
        const work = parsed.workItems[i];

        if (!work) {
          console.error(`❌ [start-work] Missing workItem for offerItem ${i}: ${offer?.name}`);
          return NextResponse.json(
            {
              error: `Hiányzó workItem a ${i}. offerItem-hez`,
              offerItem: offer,
            },
            { status: 400 }
          );
        }

        // Csak akkor írjuk felül, ha az AI más értéket adott vissza
        const fieldsToCheck: (keyof WorkItem)[] = [
          "name", "quantity", "unit", "unitPrice",
          "materialUnitPrice", "workTotal", "materialTotal", "totalPrice"
        ];

        const correctedFields: string[] = [];
        for (const field of fieldsToCheck) {
          if (String(work[field]) !== String(offer[field])) {
            correctedFields.push(`${field}: "${work[field]}" → "${offer[field]}"`);
            (work as Record<string, unknown>)[field] = offer[field];
          }
        }

        if (correctedFields.length > 0) {
          console.log(`⚠️ [start-work] Item ${i + 1} (${offer?.name}) - corrected ${correctedFields.length} fields:`);
          correctedFields.forEach(f => console.log(`    - ${f}`));
        } else {
          console.log(`✅ [start-work] Item ${i + 1} (${offer?.name}) - all fields match`);
        }
      }
    }
    // --- /Validáció és merge ---
    console.log("✅ [start-work] All items processed and merged");
    console.log(
      "📤 [start-work] Response workItems count:",
      parsed?.workItems?.length
    );

    // ✅ BACKEND WORK FRISSÍTÉS: Frissítjük a work-öt az AI eredménnyel
    if (workId && parsed) {
      console.log("💾 [start-work] Work frissítése workId-vel:", workId);
      try {
        const { updateWorkWithAIResult, setWorkProcessingFlag } = await import(
          "@/actions/work-actions"
        );

        await updateWorkWithAIResult(workId, parsed);
        console.log("✅ [start-work] Work frissítve AI eredménnyel");

        await setWorkProcessingFlag(workId, false);
        console.log("✅ [start-work] processingByAI flag false-ra állítva");
      } catch (updateErr) {
        console.error("❌ [start-work] Work frissítési hiba:", updateErr);
        // Mindenképp állítsuk false-ra a flag-et még hiba esetén is
        try {
          const { setWorkProcessingFlag } = await import("@/actions/work-actions");
          await setWorkProcessingFlag(workId, false);
          console.log("⚠️ [start-work] processingByAI flag false-ra állítva (hiba után)");
        } catch (flagErr) {
          console.error("❌ [start-work] Flag frissítési hiba:", flagErr);
        }
      }
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error("❌ [start-work] Fatal error:", err);
    console.error(
      "❌ [start-work] Error stack:",
      err instanceof Error ? err.stack : "No stack"
    );

    // ⚠️ Hiba esetén is állítsuk false-ra a processingByAI flag-et
    if (workId) {
      try {
        const { setWorkProcessingFlag } = await import("@/actions/work-actions");
        await setWorkProcessingFlag(workId, false);
        console.log("⚠️ [start-work] processingByAI flag false-ra állítva (fatal error után)");
      } catch (flagErr) {
        console.error("❌ [start-work] Flag frissítési hiba (catch block):", flagErr);
      }
    }

    return NextResponse.json(
      {
        error: "OpenAI válasz nem volt JSON.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 400 }
    );
  }
}
