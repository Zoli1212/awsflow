"use server";

import { prisma } from "@/lib/prisma";
import { getTenantSafeAuth } from "@/lib/tenant-auth";

interface ConvertOfferParams {
  title: string;
  location: string;
  customerName: string;
  estimatedTime: string;
  description: string;
  offerSummary: string;
  totalPrice: number;
  items: Array<{
    name: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    totalPrice: number;
    materialUnitPrice?: number;
    materialTotal?: number;
    workTotal?: number;
    description?: string;
  }>;
  notes: string[];
}

export async function convertExistingOfferToMyWork(params: ConvertOfferParams) {
  console.log("\n🚀 [convertExistingOfferToMyWork] STARTED");

  try {
    const { tenantEmail } = await getTenantSafeAuth();

    console.log("\n💾 [STEP 1] Creating MyWork entry...");

    // MyWork title: "Munka neve - Helyszín"
    const myWorkTitle = params.location
      ? `${params.title} - ${params.location}`
      : params.title;

    const myWork = await prisma.myWork.create({
      data: {
        title: myWorkTitle,
        location: params.location || "",
        customerName: params.customerName || "Új ügyfél",
        date: new Date(),
        time: params.estimatedTime || "1-2 nap",
        totalPrice: params.totalPrice || 0,
        tenantEmail,
      },
    });

    console.log("  ├─ MyWork created:", myWork.id);

    console.log("\n💾 [STEP 2] Creating Requirement...");

    // Requirement description tartalmazza, hogy meglévő offerből lett konvertálva
    const requirementDescription = `Meglévő ajánlatból konvertálva.\n\n${params.description || ""}`;

    const requirement = await prisma.requirement.create({
      data: {
        title: `Követelmény - ${params.title}`,
        description: requirementDescription,
        myWorkId: myWork.id,
        versionNumber: 1,
        updateCount: 1,
        questionCount: 0,
      },
    });

    console.log("  ├─ Requirement created:", requirement.id);

    console.log("\n💾 [STEP 3] Checking items against TenantPriceList...");

    // Ellenőrizzük, mely tételek NEM találhatók a TenantPriceList-ben
    const newItemNames: string[] = [];
    const itemsWithMarking = [];

    for (const item of params.items) {
      const cleanedTask = item.name.replace(/^\*+\s*/, "").trim();

      // Round ALL price fields to integers
      const roundedItem = {
        ...item,
        unitPrice: Math.round(item.unitPrice || 0),
        materialUnitPrice: Math.round(item.materialUnitPrice || 0),
        workTotal: Math.round(item.workTotal || 0),
        materialTotal: Math.round(item.materialTotal || 0),
        totalPrice: Math.round(item.totalPrice || 0),
      };

      // Ellenőrizzük, hogy létezik-e már a TenantPriceList-ben
      const existingPrice = await prisma.tenantPriceList.findUnique({
        where: {
          tenant_task_unique: {
            task: cleanedTask,
            tenantEmail,
          },
        },
      });

      if (!existingPrice) {
        // Új tétel - jelöljük meg new: true flag-gel
        newItemNames.push(cleanedTask);
        itemsWithMarking.push({
          ...roundedItem,
          name: cleanedTask,
          new: true,
        });
        console.log(`  ├─ Új tétel: ${cleanedTask}`);
      } else {
        // Meglévő tétel - nem jelöljük
        itemsWithMarking.push(roundedItem);
      }
    }

    console.log(
      `  └─ ${newItemNames.length} új tétel találva ${params.items.length}-ból`,
    );

    console.log("\n💾 [STEP 4] Creating Offer with marked items...");

    // Notes-hoz hozzáadjuk az új tételek listáját
    const notesArray = params.notes || [];
    if (newItemNames.length > 0) {
      notesArray.push(
        "\n=== Új tételek (még nincsenek a vállalkozói árlistában) ===",
      );
      newItemNames.forEach((name) => {
        notesArray.push(`- ${name}`);
      });
    }

    // Calculate materialTotal and workTotal from items
    let calculatedMaterialTotal = 0;
    let calculatedWorkTotal = 0;

    itemsWithMarking.forEach((item: any) => {
      calculatedMaterialTotal += item.materialTotal || 0;
      calculatedWorkTotal += item.workTotal || 0;
    });

    // Kerekítjük az összesítőket
    calculatedMaterialTotal = Math.round(calculatedMaterialTotal);
    calculatedWorkTotal = Math.round(calculatedWorkTotal);

    console.log(`  ├─ Calculated materialTotal: ${calculatedMaterialTotal}`);
    console.log(`  ├─ Calculated workTotal: ${calculatedWorkTotal}`);
    console.log(`  └─ Total: ${calculatedMaterialTotal + calculatedWorkTotal}`);

    const offer = await prisma.offer.create({
      data: {
        title: params.title,
        status: "draft",
        requirementId: requirement.id,
        tenantEmail,
        totalPrice: Math.round(params.totalPrice || 0),
        materialTotal: calculatedMaterialTotal,
        workTotal: calculatedWorkTotal,
        description: params.description || "",
        offerSummary: params.offerSummary || null,
        notes: notesArray.length > 0 ? notesArray.join("\n") : null,
        items: itemsWithMarking as any, // Store items with marking as JSON
        isConvertedFromExisting: true, // Meglévő ajánlatból konvertálva
      },
    });

    console.log("  ├─ Offer created:", offer.id);
    console.log("  └─ Items created:", itemsWithMarking.length);

    console.log("\n✅ [convertExistingOfferToMyWork] SUCCESS");

    return {
      success: true,
      myWorkId: myWork.id,
      requirementId: requirement.id,
      offerId: offer.id,
    };
  } catch (error) {
    console.error("\n❌ [convertExistingOfferToMyWork] ERROR:", error);
    throw error;
  }
}
