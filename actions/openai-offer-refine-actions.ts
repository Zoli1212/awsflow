"use server";

import { getTenantSafeAuth } from "@/lib/tenant-auth";
import { prisma } from "@/lib/prisma";

interface RefineOfferParams {
  refinementRequest: string;
  offerId: number;
  requirementId: number;
  existingItems: any[];
}

export async function refineOfferItems({
  refinementRequest,
  offerId,
  requirementId,
  existingItems,
}: RefineOfferParams) {
  try {
    console.log("\n🔧 [REFINE] Starting offer items refinement...");
    console.log("  ├─ Offer ID:", offerId);
    console.log("  ├─ Requirement ID:", requirementId);
    console.log("  ├─ Existing items count:", existingItems.length);
    console.log("  └─ Refinement request:", refinementRequest);

    const { tenantEmail } = await getTenantSafeAuth();

    // STEP 1: Fetch existing Offer and Requirement
    console.log("\n📋 [STEP 1] Fetching existing Offer and Requirement...");
    const existingOffer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { requirement: true },
    });

    if (!existingOffer) {
      throw new Error("Offer not found");
    }

    const existingRequirement = await prisma.requirement.findUnique({
      where: { id: requirementId },
    });

    if (!existingRequirement) {
      throw new Error("Requirement not found");
    }

    console.log("✅ [STEP 1] Offer and Requirement fetched");

    // STEP 2: Call OpenAI to refine items
    console.log("\n🤖 [STEP 2] Calling OpenAI to refine items...");

    const systemPrompt = `Te egy építőipari ajánlatkészítő asszisztens vagy. A felhasználó egy meglévő ajánlat tételeit szeretné pontosítani.

FONTOS SZABÁLYOK:
1. CSAK azokat a tételeket módosítsd, amelyeket a felhasználó kérése érint
2. A többi tételt hagyd VÁLTOZATLANUL
3. Ha a felhasználó mennyiséget módosít, számold újra az árakat
4. Ha a felhasználó árat módosít (pl. "növeld meg 10%-kal"), alkalmazd a módosítást
5. Ha a felhasználó tételt töröl, hagyd ki azt a tételből
6. Ha a felhasználó új tételt ad hozzá, add hozzá az "Egyedi tétel" jelöléssel

Válaszolj JSON formátumban:
{
  "items": [
    {
      "name": "Tétel neve",
      "quantity": "mennyiség",
      "unit": "egység",
      "materialUnitPrice": "anyag egységár Ft-ban",
      "workUnitPrice": "munka egységár Ft-ban",
      "isCustom": true/false
    }
  ],
  "explanation": "Rövid magyarázat, hogy mit módosítottál"
}`;

    const userPrompt = `Meglévő tételek:
${JSON.stringify(existingItems, null, 2)}

Pontosítási kérés:
${refinementRequest}

Módosítsd a tételeket a kérésnek megfelelően, és add vissza az összes tételt (a módosítottakat és a változatlanokat is).`;

    const openaiResponse = await fetch(
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
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          response_format: { type: "json_object" },
        }),
      }
    );

    if (!openaiResponse.ok) {
      throw new Error(`OpenAI API error: ${openaiResponse.statusText}`);
    }

    const openaiData = await openaiResponse.json();
    const aiContent = openaiData.choices[0].message.content;
    const refinedData = JSON.parse(aiContent);

    console.log("✅ [STEP 2] OpenAI refinement complete");
    console.log("  ├─ Refined items count:", refinedData.items.length);
    console.log("  └─ Explanation:", refinedData.explanation);

    // STEP 3: Calculate new totals
    console.log("\n💰 [STEP 3] Calculating new totals...");
    console.log(
      "  ├─ Raw AI items:",
      JSON.stringify(refinedData.items, null, 2)
    );

    let materialTotal = 0;
    let workTotal = 0;

    const processedItems = refinedData.items.map((item: any, index: number) => {
      console.log(`\n  Processing item ${index + 1}: ${item.name}`);

      const quantity =
        parseFloat(String(item.quantity).replace(/[^\d.-]/g, "")) || 0;
      console.log(`    ├─ Quantity: ${item.quantity} → ${quantity}`);

      // Parse material unit price
      let materialUnitPrice = 0;
      if (typeof item.materialUnitPrice === "string") {
        materialUnitPrice =
          parseFloat(item.materialUnitPrice.replace(/[^\d.-]/g, "")) || 0;
      } else if (typeof item.materialUnitPrice === "number") {
        materialUnitPrice = item.materialUnitPrice;
      }
      console.log(
        `    ├─ Material Unit Price: ${item.materialUnitPrice} → ${materialUnitPrice}`
      );

      // Parse work unit price
      let workUnitPrice = 0;
      if (typeof item.workUnitPrice === "string") {
        workUnitPrice =
          parseFloat(item.workUnitPrice.replace(/[^\d.-]/g, "")) || 0;
      } else if (typeof item.workUnitPrice === "number") {
        workUnitPrice = item.workUnitPrice;
      }
      console.log(
        `    ├─ Work Unit Price: ${item.workUnitPrice} → ${workUnitPrice}`
      );

      const materialPrice = Math.round(quantity * materialUnitPrice);
      const workPrice = Math.round(quantity * workUnitPrice);
      const totalItemPrice = Math.round(materialPrice + workPrice);

      console.log(`    ├─ Material Price: ${materialPrice}`);
      console.log(`    ├─ Work Price: ${workPrice}`);
      console.log(`    └─ Total Item Price: ${totalItemPrice}`);

      materialTotal += materialPrice;
      workTotal += workPrice;

      return {
        name: item.name,
        quantity: String(quantity),
        unit: item.unit,
        materialUnitPrice: `${Math.round(materialUnitPrice)} Ft`,
        unitPrice: `${Math.round(workUnitPrice)} Ft`,
        materialPrice: `${materialPrice} Ft`,
        price: `${workPrice} Ft`,
        workTotal: `${workPrice} Ft`,
        materialTotal: `${materialPrice} Ft`,
        totalPrice: `${totalItemPrice} Ft`,
        isCustom: item.isCustom || false,
      };
    });

    // Kerekítjük az összesítőket
    materialTotal = Math.round(materialTotal);
    workTotal = Math.round(workTotal);
    const totalPrice = Math.round(materialTotal + workTotal);

    console.log("\n✅ [STEP 3] Totals calculated");
    console.log("  ├─ Material Total:", materialTotal);
    console.log("  ├─ Work Total:", workTotal);
    console.log("  └─ Total Price:", totalPrice);

    // STEP 4: Update Offer and Requirement in database
    console.log("\n💾 [STEP 4] Updating database...");

    const updatedData = await prisma.$transaction(async (tx) => {
      // Update Requirement description with refinement request
      console.log("  ├─ Updating Requirement description...");
      let updatedDescription = existingRequirement.description || "";
      updatedDescription += `\n\nPontosítási kérés:\n${refinementRequest}\n`;

      const requirement = await tx.requirement.update({
        where: { id: requirementId },
        data: {
          updateCount: existingRequirement.updateCount + 1,
          description: updatedDescription,
        },
      });

      console.log("  ├─ Requirement updated");

      // Update Offer with new items and totals
      console.log("  ├─ Updating Offer items and totals...");
      const offer = await tx.offer.update({
        where: { id: offerId },
        data: {
          items: processedItems,
          materialTotal,
          workTotal,
          totalPrice,
        },
      });

      console.log("  └─ Offer updated");

      return { requirement, offer };
    });

    console.log("✅ [STEP 4] Database update successful");
    console.log("\n✅ [SUCCESS] Offer items refined");
    console.log("  ├─ Offer ID:", updatedData.offer.id);
    console.log("  ├─ Requirement ID:", updatedData.requirement.id);
    console.log("  └─ Explanation:", refinedData.explanation);

    return {
      success: true,
      offerId: updatedData.offer.id,
      requirementId: updatedData.requirement.id,
      offer: refinedData,
      explanation: refinedData.explanation,
    };
  } catch (error) {
    console.error("❌ [REFINE] Error refining offer items:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
