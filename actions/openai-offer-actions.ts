"use server";

import { prisma } from "@/lib/prisma";
import { getTenantSafeAuth } from "@/lib/tenant-auth";
import { Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { enhancePromptWithRAG } from "@/actions/rag-context-actions";

// PriceList cache
let priceListCache: any[] | null = null;
let priceListCacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 perc

async function getPriceListForCategories(
  categories: string[],
  tenantEmail: string,
): Promise<any[]> {
  console.log(`🔄 PriceList betöltés (${categories.length} kategória)...`);

  try {
    // 1. Betöltjük a tenant-specifikus árakat (TenantPriceList)
    const tenantPriceList = await prisma.tenantPriceList.findMany({
      where: {
        tenantEmail: tenantEmail,
        category: { in: categories },
      },
      select: {
        category: true,
        task: true,
        unit: true,
        laborCost: true,
        materialCost: true,
      },
      orderBy: [{ category: "asc" }, { task: "asc" }],
    });
    console.log(`  ├─ TenantPriceList: ${tenantPriceList.length} tétel`);

    // 2. Betöltjük a globális árakat (PriceList)
    const globalPriceList = await prisma.priceList.findMany({
      where: {
        tenantEmail: "",
        category: { in: categories },
      },
      select: {
        category: true,
        task: true,
        unit: true,
        laborCost: true,
        materialCost: true,
      },
      orderBy: [{ category: "asc" }, { task: "asc" }],
    });
    console.log(`  ├─ GlobalPriceList: ${globalPriceList.length} tétel`);

    // 3. Merge: tenant-specifikus felülírja a globálist
    const mergedMap = new Map<string, any>();

    // Először a globális árakat
    globalPriceList.forEach((item) => {
      const key = `${item.category}|||${item.task}`;
      mergedMap.set(key, item);
    });

    // Aztán a tenant-specifikus árak felülírják
    tenantPriceList.forEach((item) => {
      const key = `${item.category}|||${item.task}`;
      mergedMap.set(key, item);
    });

    const mergedPriceList = Array.from(mergedMap.values());
    console.log(
      `✅ PriceList betöltve: ${mergedPriceList.length} tétel (${tenantPriceList.length} tenant + ${globalPriceList.length} global)`,
    );
    return mergedPriceList;
  } catch (error) {
    console.error("❌ PriceList hiba:", error);
    return [];
  }
}

interface CreateOfferParams {
  userInput: string;
  existingItems?: any[];
}

export async function createOfferFromText({
  userInput,
  existingItems = [],
}: CreateOfferParams) {
  console.log("\n🚀 [createOfferFromText] STARTED");

  try {
    const { tenantEmail } = await getTenantSafeAuth();

    console.log("\n📝 [STEP 1] Building input...");
    const baseInput =
      existingItems.length > 0
        ? `${userInput}\n\nMeglévő tételek (ne vegyél fel ismétlődést):\n${JSON.stringify(existingItems, null, 2)}`
        : userInput;
    console.log("✅ [STEP 1] Input built");

    console.log("\n🔍 [STEP 2] RAG Context Enhancement...");
    let finalInput = baseInput;

    if (process.env.RAG_ENABLED === "true") {
      try {
        const ragEnhancedInput = await enhancePromptWithRAG(
          baseInput,
          userInput,
          true,
        );
        finalInput = ragEnhancedInput;
        console.log("✅ [STEP 2] RAG enhancement successful");
      } catch (ragError) {
        console.error("⚠️ [STEP 2] RAG error:", ragError);
        finalInput = baseInput;
      }
    } else {
      console.log("⏭️  [STEP 2] RAG disabled, skipping");
    }

    console.log("\n📚 [STEP 2.5] Loading task catalog for AI (no prices)...");

    // 1. Betöltjük a tenant-specifikus task-okat (PRIORITÁS 1)
    const tenantTaskCatalog = await prisma.tenantPriceList.findMany({
      where: { tenantEmail: tenantEmail },
      select: {
        category: true,
        task: true,
        unit: true,
      },
      orderBy: [{ category: "asc" }, { task: "asc" }],
    });
    console.log(`  ├─ TenantPriceList tasks: ${tenantTaskCatalog.length}`);

    // 2. Betöltjük a globális task-okat (PRIORITÁS 2)
    const globalTaskCatalog = await prisma.priceList.findMany({
      where: { tenantEmail: "" },
      select: {
        category: true,
        task: true,
        unit: true,
      },
      orderBy: [{ category: "asc" }, { task: "asc" }],
    });
    console.log(`  ├─ GlobalPriceList tasks: ${globalTaskCatalog.length}`);

    // 3. Külön tartjuk a két listát prioritással
    const tenantTasksWithPriority = tenantTaskCatalog.map((item) => ({
      ...item,
      source: "tenant",
    }));
    const globalTasksWithPriority = globalTaskCatalog.map((item) => ({
      ...item,
      source: "global",
    }));

    console.log(
      `✅ [STEP 2.5] Loaded ${tenantTaskCatalog.length} tenant + ${globalTaskCatalog.length} global tasks`,
    );

    // Ha van bármelyik katalógus, használja prioritással
    if (tenantTaskCatalog.length > 0 || globalTaskCatalog.length > 0) {
      let catalogSection = "\n\n===TASK KATALÓGUS PRIORITÁSI SORRENDBEN===\n";
      catalogSection += "FONTOS: Válassz az alábbi sorrendben:\n";
      catalogSection += "1. PRIORITÁS - TENANT SAJÁT TÉTELEK (ezeket preferáld!):\n";

      if (tenantTaskCatalog.length > 0) {
        catalogSection += JSON.stringify(tenantTasksWithPriority, null, 2);
      } else {
        catalogSection += "(nincs tenant-specifikus tétel)\n";
      }

      catalogSection += "\n\n2. PRIORITÁS - GLOBÁLIS TÉTELEK (ha nincs megfelelő tenant tétel):\n";
      if (globalTaskCatalog.length > 0) {
        catalogSection += JSON.stringify(globalTasksWithPriority, null, 2);
      } else {
        catalogSection += "(nincs globális tétel)\n";
      }

      catalogSection += "\n\n3. PRIORITÁS - EGYEDI TÉTEL (customTask: true) - CSAK ha sem tenant, sem global listában nincs megfelelő!";

      finalInput = `${finalInput}${catalogSection}`;
      console.log("  ├─ Catalog mode: AI will choose with priority (tenant > global > custom)");
    } else {
      finalInput = `${finalInput}\n\n===NINCS TASK KATALÓGUS===\nSzabadon generálhatsz task-okat a követelmények alapján. Adj meg reális kategóriákat, task neveket és egységeket.`;
      console.log("  ├─ Free mode: AI will generate tasks freely (no catalog)");
    }

    console.log("\n🤖 [STEP 3] Calling OpenAI API (gpt-4o) - Initial pass...");

    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    let retries = 2;
    let result: any = null;
    let lastError: any = null;

    while (retries > 0) {
      try {
        const attemptNum = 3 - retries;
        console.log(`\n  🔄 Attempt ${attemptNum}/2...`);

        const response = await fetch(
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
                  content: `Te egy felújítási ajánlatkészítő szakértő vagy. A felhasználó igényei alapján KÖTELEZŐEN egy teljes, részletes JSON formátumú ajánlatot készítesz.

**KRITIKUS SZABÁLYOK:**
1. MINDIG adj vissza TELJES ajánlatot, még ha hiányos az információ is
2. Ha valami nem tisztázott, adj vissza becslést ÉS add hozzá a "questions" részhez
3. SOHA ne add vissza: "További információ szükséges" - helyette MINDIG generálj ajánlatot a rendelkezésre álló adatok alapján
4. A "questions" rész KÖTELEZŐ, ha bármilyen információ hiányzik
5. Az "offerSummary" KÖTELEZŐ - pontosan 4 mondat magyarul

**TASK KATALÓGUS HASZNÁLATA - PRIORITÁSI SORREND:**
6. Ha van "===TASK KATALÓGUS PRIORITÁSI SORRENDBEN===" akkor KÖTELEZŐ ez a sorrend:
   a) ELŐSZÖR a "1. PRIORITÁS - TENANT SAJÁT TÉTELEK" listából válassz (source: "tenant")
   b) HA nincs megfelelő tenant tétel, AKKOR a "2. PRIORITÁS - GLOBÁLIS TÉTELEK" listából (source: "global")
   c) CSAK HA egyik listában sincs megfelelő, AKKOR használj egyedi tételt (customTask: true)
   - A válaszban add meg a "source" mezőt is: "tenant", "global", vagy "custom"
7. Ha "===NINCS TASK KATALÓGUS===" üzenet látható:
   - Szabadon generálhatsz task-okat a követelmények alapján
   - Adj meg reális kategóriákat, task neveket és egységeket
   - Minden task legyen "customTask": true, source: "custom"
   - Használj standard felújítási kategóriákat (pl. "Burkolás", "Festés", "Villanyszerelés", stb.)

**ANYAGÁRAK KEZELÉSE:**
7. Ha a követelményben szerepelnek anyagárak (pl. "Zuhanyzó 150000 Ft", "WC 50000 Ft", "Kád 160000 Ft"), akkor KÖTELEZŐEN:
   - Hozz létre KÜLÖN tételeket az ANYAGOKRA (pl. "Zuhanyzó", "WC", "Kád") - ezek legyenek customTask: true
   - Hozz létre KÜLÖN tételeket a MUNKÁKRA (pl. "Zuhanyzó felszerelése", "WC bekötése") - ezeket a PRICE CATALOG-ból válaszd
8. Ha "ügyfél által biztosított" szerepel, akkor azt az anyagot NEM kell beletenni az ajánlatba
9. Csempék esetén is hozz létre külön tételeket az anyagra és a ragasztásra

**IDŐBECSLÉS SZABÁLYOK:**
10. Az "estimatedTime" értéket a munka TÉNYLEGES mennyisége alapján becsüld meg:
    - Kis munka (1-5 m2 burkolás, 1-2 ajtó): "1-2 nap"
    - Közepes munka (10-20 m2 burkolás, 1 fürdőszoba): "3-5 nap"
    - Nagyobb munka (30-50 m2 burkolás, komplett fürdőszoba): "7-10 nap"
    - Nagy munka (teljes lakás felújítás, 60+ m2): "14-21 nap"
    - Számítsd bele a szárítási, száradási időket is!
11. NE használj fix "10 nap" értéket minden munkára - MINDIG a munka mennyiségét vedd figyelembe!

**VÁLASZ FORMÁTUM (szigorúan JSON):**
{
  "offer": {
    "title": "Rövid összefoglaló cím",
    "location": "Helyszín",
    "customerName": "Ügyfél neve (ha van)",
    "estimatedTime": "Becsült idő napokban (pl. '3-5 nap', '7-10 nap', '14-21 nap')",
    "offerSummary": "4 mondatos összefoglaló",
    "items": [
      {
        "task": "Pontos task név a katalógusból",
        "category": "Kategória",
        "unit": "egység",
        "quantity": 0,
        "source": "tenant|global|custom",
        "customTask": false,
        "customReason": "Indoklás ha customTask=true"
      }
    ],
    "questions": [
      "Tisztázandó kérdés 1?",
      "Tisztázandó kérdés 2?"
    ]
  }
}

Válaszolj CSAK érvényes JSON-nal, semmi mással!`,
                },
                { role: "user", content: finalInput },
              ],
              max_tokens: 4000,
              temperature: 0.1,
            }),
          },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `OpenAI API error: ${response.status} - ${JSON.stringify(errorData)}`,
          );
        }

        const data = await response.json();
        result = data.choices?.[0]?.message?.content;

        console.log(
          "  ✅ Response received, length:",
          result?.length || 0,
          "chars",
        );
        break;
      } catch (error: any) {
        lastError = error;
        console.error("  ❌ Request failed:", error?.message);

        const is429 =
          error?.message?.includes("429") ||
          error?.message?.includes("rate limit");

        if (is429 && retries > 1) {
          console.log(`  ⚠️ Rate limit, waiting 120s...`);
          await new Promise((resolve) => setTimeout(resolve, 120 * 1000));
          retries--;
        } else {
          throw error;
        }
      }
    }

    if (!result) {
      throw lastError || new Error("AI returned no result");
    }

    console.log("✅ [STEP 3] AI response received");

    console.log("\n📋 [STEP 4] Parsing AI Response...");
    let cleanedResult = result
      .trim()
      .replace(/^```json[\r\n]*/i, "")
      .replace(/^```[\r\n]*/i, "")
      .replace(/```$/, "")
      .trim();

    let parsedOffer;
    try {
      parsedOffer = JSON.parse(cleanedResult);
    } catch (parseError) {
      console.error("❌ JSON parse failed");
      throw new Error("Failed to parse AI response");
    }

    const offerData = parsedOffer.offer || parsedOffer;
    const aiItems = offerData.items || [];
    const questions = offerData.questions || [];
    const offerSummary = offerData.offerSummary || null;

    console.log("✅ [STEP 4] JSON parsed successfully");
    console.log("  ├─ AI Items:", aiItems.length);
    console.log("  ├─ Questions:", questions.length);
    console.log("  └─ Has offerSummary:", !!offerSummary);

    console.log("\n📚 [STEP 5] Loading prices for AI selected tasks...");
    const categories = [
      ...new Set(aiItems.map((item: any) => item.category).filter(Boolean)),
    ] as string[];
    console.log("  ├─ Categories:", categories);

    // Külön betöltjük a tenant és global árakat a source alapú kereséshez
    const tenantPrices = await prisma.tenantPriceList.findMany({
      where: {
        tenantEmail: tenantEmail,
        category: { in: categories },
      },
      select: {
        category: true,
        task: true,
        unit: true,
        laborCost: true,
        materialCost: true,
      },
    });
    console.log(`  ├─ Tenant prices loaded: ${tenantPrices.length}`);

    const globalPrices = await prisma.priceList.findMany({
      where: {
        tenantEmail: "",
        category: { in: categories },
      },
      select: {
        category: true,
        task: true,
        unit: true,
        laborCost: true,
        materialCost: true,
      },
    });
    console.log(`  └─ Global prices loaded: ${globalPrices.length}`);

    console.log("\n💰 [STEP 6] Building final items with prices (priority: tenant > global > custom)...");
    const finalItems: any[] = [];
    const customItems: any[] = [];

    aiItems.forEach((aiItem: any) => {
      const source = aiItem.source || "custom";
      let match = null;

      // Prioritás alapján keresünk
      if (source === "tenant") {
        // Először tenant-ből
        match = tenantPrices.find(
          (p) => p.category === aiItem.category && p.task === aiItem.task,
        );
        if (!match) {
          // Ha nincs tenant-ben, próbálunk global-ból
          match = globalPrices.find(
            (p) => p.category === aiItem.category && p.task === aiItem.task,
          );
        }
      } else if (source === "global") {
        // Global-ból keresünk
        match = globalPrices.find(
          (p) => p.category === aiItem.category && p.task === aiItem.task,
        );
      }
      // Ha source === "custom", nem keresünk árlistából

      if (match) {
        // Found in pricelist - use those prices
        const laborCost = match.laborCost || 0;
        const materialCost = match.materialCost || 0;
        const quantity = aiItem.quantity || 0;
        const unitPrice = laborCost;
        const materialUnitPrice = materialCost;
        const workTotal = laborCost * quantity;
        const materialTotal = materialCost * quantity;
        const totalPrice = workTotal + materialTotal;

        finalItems.push({
          new: false,
          source: source,
          name: aiItem.task,
          unit: aiItem.unit,
          quantity: String(quantity),
          unitPrice: String(unitPrice),
          workTotal: String(workTotal),
          totalPrice: String(totalPrice),
          materialTotal: String(materialTotal),
          materialUnitPrice: String(materialUnitPrice),
        });

        console.log(
          `  ├─ [${source.toUpperCase()}] Matched: ${aiItem.task} (${laborCost} + ${materialCost})`,
        );
      } else {
        // Not found in pricelist - need AI estimation
        customItems.push(aiItem);
        console.log(`  ⚠️ [CUSTOM] Needs AI pricing: ${aiItem.task}`);
      }
    });
    console.log(
      "✅ [STEP 6] Items built:",
      finalItems.length,
      "standard,",
      customItems.length,
      "custom",
    );

    // If there are custom items, ask AI to estimate
    if (customItems.length > 0) {
      console.log(
        `\n🤖 [STEP 6.5] AI price estimation for ${customItems.length} custom items...`,
      );

      try {
        const priceEstimationPrompt = `Adj meg 2025-ös reális budapesti felújítási árakat az alábbi egyedi tételekhez. Válaszolj CSAK JSON formátumban:

${JSON.stringify(
  customItems.map((item) => ({
    task: item.task,
    unit: item.unit,
    quantity: item.quantity,
    reason: item.customReason,
  })),
  null,
  2,
)}

FONTOS SZABÁLYOK:
1. Ha a task nevében szerepel ár (pl. "Zuhanyzó 150000", "WC 50000"), akkor:
   - A materialCost legyen a megadott ár
   - A laborCost legyen 0 (mivel ez csak az anyag beszerzése)
2. Ha a task egy anyag (pl. "Zuhanyzó", "WC", "Kád", "Csempe") és nincs ár megadva:
   - Becsüld meg a materialCost-ot
   - A laborCost legyen 0
3. Egyéb custom tételek esetén adj meg reális munkadíjat és anyagköltséget

Válasz formátum:
{
  "prices": [
    {
      "task": "Feladat neve",
      "laborCost": 0,
      "materialCost": 0
    }
  ]
}`;

        const priceResponse = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content:
                    "Te egy felújítási árbecslő szakértő vagy. Adj meg reális 2025-ös budapesti árakat.",
                },
                { role: "user", content: priceEstimationPrompt },
              ],
              max_tokens: 1000,
              temperature: 0.1,
            }),
          },
        );

        if (priceResponse.ok) {
          const priceData = await priceResponse.json();
          const priceResult = priceData.choices?.[0]?.message?.content;

          const cleanedPriceResult = priceResult
            .trim()
            .replace(/^```json[\r\n]*/i, "")
            .replace(/^```[\r\n]*/i, "")
            .replace(/```$/, "")
            .trim();

          const parsedPrices = JSON.parse(cleanedPriceResult);

          // Apply AI-estimated prices and add to finalItems
          customItems.forEach((customItem: any) => {
            const priceMatch = parsedPrices.prices?.find(
              (p: any) => p.task === customItem.task,
            );
            if (priceMatch) {
              const laborCost = priceMatch.laborCost || 0;
              const materialCost = priceMatch.materialCost || 0;
              const quantity = customItem.quantity || 0;
              const unitPrice = laborCost;
              const materialUnitPrice = materialCost;
              const workTotal = laborCost * quantity;
              const materialTotal = materialCost * quantity;
              const totalPrice = workTotal + materialTotal;

              finalItems.push({
                new: true,
                source: "custom",
                name: customItem.task,
                unit: customItem.unit,
                quantity: String(quantity),
                unitPrice: String(unitPrice),
                workTotal: String(workTotal),
                totalPrice: String(totalPrice),
                materialTotal: String(materialTotal),
                materialUnitPrice: String(materialUnitPrice),
              });

              console.log(
                `  ├─ [CUSTOM] AI estimated: ${customItem.task} (${laborCost} + ${materialCost})`,
              );
            }
          });

          console.log("✅ [STEP 6.5] AI price estimation complete");
        }
      } catch (error) {
        console.error("⚠️ [STEP 6.5] AI price estimation failed:", error);
        console.log("  └─ Continuing with 0 prices for unmatched items");
      }
    }

    console.log("\n💾 [STEP 7] Preparing offer data...");

    const title = offerData.title || "Új ajánlat";
    const location = offerData.location || "Helyszín nincs megadva";
    const customerName = offerData.customerName || "Új ügyfél";

    // Ensure estimatedTime is a string
    let estimatedTime = "1-2 nap";
    if (offerData.estimatedTime) {
      estimatedTime =
        typeof offerData.estimatedTime === "number"
          ? `${offerData.estimatedTime} nap`
          : String(offerData.estimatedTime);
    }

    // Calculate totals from finalItems
    let materialTotalCalc = 0;
    let workTotalCalc = 0;

    finalItems.forEach((item: any) => {
      materialTotalCalc += parseFloat(item.materialTotal) || 0;
      workTotalCalc += parseFloat(item.workTotal) || 0;
    });

    const totalPrice = materialTotalCalc + workTotalCalc;
    console.log("  ├─ Material Total:", materialTotalCalc);
    console.log("  ├─ Work Total:", workTotalCalc);
    console.log("  └─ Total Price:", totalPrice);

    console.log("\n📝 [STEP 8] Building notes with custom items...");
    let notesContent = `${location}\n\n${userInput}\n\n`;

    if (customItems.length > 0) {
      notesContent += "További információ:\n\n";
      customItems.forEach((customItem: any) => {
        notesContent += `A következő tétel nem volt az adatbázisban: '${customItem.task} (egyedi tétel)'.\n\n`;
        notesContent += `Indoklás: ${customItem.customReason || "Egyedi tétel"}\n\n`;
      });
    }

    if (questions.length > 0) {
      notesContent += "Tisztázandó kérdések:\n\n";
      questions.forEach((q: string, i: number) => {
        notesContent += `${i + 1}. ${q}\n\n`;
      });
    }
    console.log("✅ [STEP 8] Notes built");

    // Transaction to save Work → Requirement → Offer
    console.log("\n💾 [STEP 9] Saving to database...");
    const savedData = await prisma.$transaction(async (tx) => {
      // 1. Create MyWork
      console.log("  ├─ Creating MyWork...");
      const work = await tx.myWork.create({
        data: {
          title,
          customerName,
          date: new Date(),
          location,
          time: estimatedTime,
          totalPrice,
          tenantEmail,
        } as Prisma.MyWorkCreateInput,
      });

      console.log("  ├─ Work created:", work.id);

      // 2. Create Requirement
      console.log("  ├─ Creating Requirement for Work ID:", work.id);

      const requirement = await tx.requirement.create({
        data: {
          title: `Követelmény - ${title}`,
          description: userInput,
          myWorkId: work.id,
          versionNumber: 1,
          updateCount: 1,
          questionCount: questions.length || 0,
        },
      });

      console.log("  ├─ Requirement created:", requirement.id);

      // 3. Create Offer
      console.log("  ├─ Creating Offer for Requirement ID:", requirement.id);
      console.log("  ├─ estimatedTime value:", estimatedTime);

      const offer = await tx.offer.create({
        data: {
          title,
          description: notesContent,
          location: location,
          totalPrice,
          materialTotal: materialTotalCalc,
          workTotal: workTotalCalc,
          status: "draft",
          requirementId: requirement.id,
          items: finalItems,
          recordId: uuidv4(),
          tenantEmail,
          offerSummary: offerSummary,
          estimatedDuration: estimatedTime, // AI becslés az időtartamra
          validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        },
      });

      console.log(
        "  ├─ Offer created with estimatedDuration:",
        offer.estimatedDuration,
      );

      console.log("  └─ Offer created:", offer.id);

      return { work, requirement, offer };
    });

    console.log("✅ [STEP 7] Database save successful");
    console.log("\n✅ [SUCCESS] Offer created");
    console.log("  ├─ Work ID:", savedData.work.id);
    console.log("  ├─ Requirement ID:", savedData.requirement.id);
    console.log("  └─ Offer ID:", savedData.offer.id);

    return {
      success: true,
      workId: savedData.work.id,
      requirementId: savedData.requirement.id,
      offerId: savedData.offer.id,
      offer: offerData,
    };
  } catch (error) {
    console.error("❌ [FATAL ERROR]:", error);
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}
