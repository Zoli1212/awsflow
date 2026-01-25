"use server";

import { getTenantSafeAuth } from "@/lib/tenant-auth";
import { prisma } from "@/lib/prisma";
import { v4 as uuidv4 } from "uuid";

interface UpdateOfferParams {
  userInput: string;
  existingItems: any[];
  answeredQuestions?: string[];
  requirementId: number;
  currentOfferId: number;
}

export async function updateOfferFromAnswers({
  userInput,
  existingItems = [],
  answeredQuestions = [],
  requirementId,
  currentOfferId,
}: UpdateOfferParams) {
  console.log("\n🔄 [updateOfferFromAnswers] STARTED");

  try {
    const { tenantEmail } = await getTenantSafeAuth();

    // Get the existing requirement to find the MyWork
    console.log("\n📋 [STEP 0] Loading existing requirement...");
    const existingRequirement = await prisma.requirement.findUnique({
      where: { id: requirementId },
      include: { myWork: true },
    });

    if (!existingRequirement) {
      throw new Error("Requirement not found");
    }

    const myWorkId = existingRequirement.myWorkId;
    const previousQuestionCount = existingRequirement.questionCount || 0;
    console.log("  ├─ MyWork ID:", myWorkId);
    console.log("  └─ Previous questionCount:", previousQuestionCount);

    console.log("\n📝 [STEP 1] Building input with answered questions...");
    console.log("  ├─ Existing items:", existingItems.length);
    console.log("  └─ Answered questions:", answeredQuestions.length);

    console.log("\n🤖 [STEP 2] Calling OpenAI API (gpt-4o)...");

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
                  content: `Te egy felújítási ajánlat frissítő szakértő vagy. A felhasználó megválaszolt néhány kérdést egy meglévő ajánlathoz.

**KRITIKUS SZABÁLYOK - MEGLÉVŐ TÉTELEK KEZELÉSE:**
1. A meglévő tételeket CSAK akkor módosítsd, ha a válaszok KÖZVETLENÜL érintik őket
2. Ha egy tétel NEM érintett a válaszokban, akkor PONTOSAN ugyanúgy add vissza (quantity, task, category, unit változatlan)
3. Ha új munka szükséges a válaszok alapján, adj hozzá ÚJ tételeket
4. SOHA ne törölj meglévő tételeket, csak bővítsd vagy módosítsd őket ha szükséges
5. Az "offerSummary" legyen 4 mondat magyarul, frissítve a válaszok alapján
6. CSAK az AVAILABLE TASKS listából válassz task-okat! Ha valami nincs benne, jelöld meg "customTask": true-val

**PÉLDA - Meglévő tételek kezelése:**
Ha a meglévő ajánlat tartalmazza: "Falburkolat bontása" 10 m2
És a válasz: "A csempe színe legyen kék"
Akkor:
- "Falburkolat bontása" 10 m2 → VÁLTOZATLAN (nem érintett)
- ÚJ tétel: "Csempe burkolás" megfelelő mennyiséggel

**VÁLASZ FORMÁTUM (szigorúan JSON):**
{
  "offer": {
    "title": "Rövid összefoglaló cím",
    "location": "Helyszín",
    "customerName": "Ügyfél neve (ha van)",
    "estimatedTime": "Becsült idő napokban",
    "offerSummary": "4 mondatos összefoglaló a válaszok alapján frissítve",
    "items": [
      {
        "task": "Pontos task név az AVAILABLE TASKS listából",
        "category": "Kategória az AVAILABLE TASKS listából",
        "unit": "egység az AVAILABLE TASKS listából",
        "quantity": 0,
        "customTask": false,
        "customReason": "Indoklás ha customTask=true"
      }
    ],
    "questions": [
      "További tisztázandó kérdés (ha van)"
    ]
  }
}`,
                },
                {
                  role: "user",
                  content: `${userInput}

===MEGLÉVŐ TÉTELEK (ezeket csak akkor módosítsd, ha a válaszok érintik őket)===
${JSON.stringify(existingItems, null, 2)}`,
                },
              ],
              temperature: 0.7,
              max_tokens: 4000,
            }),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `OpenAI API error: ${response.status} - ${errorText}`
          );
        }

        const data = await response.json();
        console.log("  ✅ OpenAI response received");

        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("No content in OpenAI response");
        }

        console.log("\n📦 [STEP 3] Parsing JSON response...");
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error("No JSON found in response");
        }

        result = JSON.parse(jsonMatch[0]);
        console.log("  ✅ JSON parsed successfully");
        break;
      } catch (error) {
        lastError = error;
        retries--;
        const failedAttempt = 3 - retries - 1;
        console.error(`  ❌ Attempt ${failedAttempt}/2 failed:`, error);
        if (retries > 0) {
          console.log("  🔄 Retrying...");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    if (!result) {
      throw lastError || new Error("Failed to get valid response from OpenAI");
    }

    const offerData = result.offer;
    console.log("✅ [STEP 3] Offer data extracted");

    // Extract data
    const items = offerData.items || [];
    const questions = offerData.questions || [];
    const offerSummary = offerData.offerSummary || "";

    console.log("\n📊 [STEP 4] Offer data summary:");
    console.log("  ├─ Items:", items.length);
    console.log("  ├─ Questions:", questions.length);
    console.log("  └─ Offer Summary:", offerSummary ? "Yes" : "No");

    // STEP 2.5: Load compact task catalog (without prices)
    console.log("\n📚 [STEP 2.5] Loading compact task catalog...");
    const taskCatalog = await prisma.priceList.findMany({
      where: { tenantEmail: "" },
      select: { category: true, task: true, unit: true },
      orderBy: [{ category: "asc" }, { task: "asc" }],
    });
    console.log(
      `✅ [STEP 2.5] Task catalog loaded: ${taskCatalog.length} tasks`
    );

    // STEP 5: Load prices for selected categories
    console.log("\n💰 [STEP 5] Loading prices for selected categories...");
    const categories = Array.from(
      new Set(items.map((item: any) => item.category).filter(Boolean))
    ) as string[];
    console.log("  └─ Categories:", categories);

    const priceList = await prisma.priceList.findMany({
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
    console.log(`✅ [STEP 5] Prices loaded: ${priceList.length} items`);

    // STEP 6: Match prices to items
    console.log("\n🔗 [STEP 6] Matching prices to items...");
    const itemsWithPrices: any[] = [];
    const customItems: any[] = [];

    items.forEach((item: any) => {
      const priceMatch = priceList.find(
        (p) =>
          p.category === item.category &&
          p.task === item.task &&
          p.unit === item.unit
      );

      if (priceMatch) {
        itemsWithPrices.push({
          ...item,
          laborCost: priceMatch.laborCost || 0,
          materialCost: priceMatch.materialCost || 0,
        });
        console.log(`  ✅ Matched: ${item.task}`);
      } else {
        customItems.push(item);
        console.log(`  ⚠️  No match: ${item.task} (will request AI pricing)`);
      }
    });

    // STEP 6.5: AI price estimation for custom items
    if (customItems.length > 0) {
      console.log(
        "\n💡 [STEP 6.5] Requesting AI price estimation for custom items..."
      );
      try {
        const priceEstimationPrompt = `Becsüld meg a következő egyedi tételek árait (munkadíj és anyagköltség külön):

${JSON.stringify(customItems, null, 2)}

Adj vissza JSON formátumban:
{
  "items": [
    {
      "task": "tétel neve",
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
                    "Te egy építőipari árbecslő szakértő vagy. Adj reális árakat HUF-ban.",
                },
                { role: "user", content: priceEstimationPrompt },
              ],
              temperature: 0.3,
              max_tokens: 2000,
            }),
          }
        );

        if (priceResponse.ok) {
          const priceData = await priceResponse.json();
          const priceContent = priceData.choices?.[0]?.message?.content;
          const priceJsonMatch = priceContent?.match(/\{[\s\S]*\}/);

          if (priceJsonMatch) {
            const priceResult = JSON.parse(priceJsonMatch[0]);
            const estimatedItems = priceResult.items || [];

            customItems.forEach((customItem) => {
              const estimated = estimatedItems.find(
                (e: any) => e.task === customItem.task
              );
              if (estimated) {
                itemsWithPrices.push({
                  ...customItem,
                  laborCost: estimated.laborCost || 0,
                  materialCost: estimated.materialCost || 0,
                });
                console.log(
                  `  ✅ AI estimated: ${customItem.task} - Labor: ${estimated.laborCost}, Material: ${estimated.materialCost}`
                );
              } else {
                itemsWithPrices.push({
                  ...customItem,
                  laborCost: 0,
                  materialCost: 0,
                });
              }
            });
          }
          console.log("✅ [STEP 6.5] AI price estimation complete");
        }
      } catch (error) {
        console.error("⚠️ [STEP 6.5] AI price estimation failed:", error);
        console.log("  └─ Continuing with 0 prices for unmatched items");
      }
    }

    console.log("\n💾 [STEP 7] Preparing offer data...");

    const baseTitle = offerData.title || "Új ajánlat";
    const title = `${baseTitle} (megválaszolt)`;
    const location = offerData.location || "Helyszín nincs megadva";
    const customerName = offerData.customerName || "Új ügyfél";

    let estimatedTime = "1-2 nap";
    if (offerData.estimatedTime) {
      estimatedTime =
        typeof offerData.estimatedTime === "number"
          ? `${offerData.estimatedTime} nap`
          : String(offerData.estimatedTime);
    }

    // Format items to legacy format
    const finalItems = itemsWithPrices.map((item: any) => {
      const quantity = item.quantity || 1;
      const laborCost = item.laborCost || 0;
      const materialCost = item.materialCost || 0;
      const workTotal = Math.round(laborCost * quantity);
      const materialTotal = Math.round(materialCost * quantity);
      const totalPrice = Math.round(workTotal + materialTotal);

      return {
        new: true,
        name: `${item.task}${item.customTask ? " !" : ""}`,
        unit: item.unit || "db",
        quantity: quantity,
        unitPrice: Math.round(laborCost),
        workTotal: workTotal,
        totalPrice: totalPrice,
        materialTotal: materialTotal,
        materialUnitPrice: Math.round(materialCost),
      };
    });

    const workTotalCalc = Math.round(finalItems.reduce(
      (sum: number, item: any) => sum + (item.workTotal || 0),
      0
    ));
    const materialTotalCalc = Math.round(finalItems.reduce(
      (sum: number, item: any) => sum + (item.materialTotal || 0),
      0
    ));
    const totalPrice = Math.round(workTotalCalc + materialTotalCalc);

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

    // Add new questions if any (from AI response)
    if (questions.length > 0) {
      notesContent += "Tisztázandó kérdések:\n\n";
      questions.forEach((q: string, i: number) => {
        notesContent += `${i + 1}. ${q}\n\n`;
      });
    }
    console.log("✅ [STEP 8] Notes built");

    // Transaction to update Requirement and create new Offer
    console.log("\n💾 [STEP 9] Saving to database...");
    const savedData = await prisma.$transaction(async (tx) => {
      // 1. Update existing Requirement
      console.log("  ├─ Updating existing Requirement ID:", requirementId);
      console.log(
        "  ├─ Increasing versionNumber from",
        existingRequirement.versionNumber,
        "to",
        existingRequirement.versionNumber + 1
      );
      console.log(
        "  ├─ Increasing updateCount from",
        existingRequirement.updateCount,
        "to",
        existingRequirement.updateCount + 1
      );
      console.log(
        "  ├─ Increasing questionCount from",
        previousQuestionCount,
        "to",
        previousQuestionCount + 1
      );

      // Build updated description with questions and answers
      let updatedDescription = existingRequirement.description || "";
      if (!updatedDescription.includes("Válaszok a kérdésekre:")) {
        updatedDescription += "\n\nVálaszok a kérdésekre:\n";
      }
      updatedDescription += userInput.split("Válaszok a kérdésekre:")[1] || "";

      const requirement = await tx.requirement.update({
        where: { id: requirementId },
        data: {
          versionNumber: existingRequirement.versionNumber + 1,
          updateCount: existingRequirement.updateCount + 1,
          questionCount: previousQuestionCount + 1,
          description: updatedDescription,
        },
      });

      console.log("  ├─ Requirement updated:", requirement.id);

      // 2. Create new Offer
      console.log(
        "  ├─ Creating new Offer for Requirement ID:",
        requirement.id
      );

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
          validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        },
      });

      console.log("  └─ Offer created:", offer.id);

      return { requirement, offer };
    });

    console.log("✅ [STEP 9] Database save successful");
    console.log("\n✅ [SUCCESS] Offer updated");
    console.log("  ├─ MyWork ID:", myWorkId, "(unchanged)");
    console.log("  ├─ Requirement ID:", savedData.requirement.id);
    console.log("  └─ Offer ID:", savedData.offer.id);

    return {
      success: true,
      workId: myWorkId,
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
