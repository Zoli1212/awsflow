"use server";

import { prisma } from "@/lib/prisma";
import { getTenantSafeAuth } from "@/lib/tenant-auth";
import { revalidatePath } from "next/cache";

export async function addWorkItemAndOfferItem(workId: number, itemData?: {
  name: string;
  quantity: number;
  unit: string;
  materialUnitPrice: string;
  unitPrice: string;
}) {
  try {
    const { user, tenantEmail } = await getTenantSafeAuth();

    // Verify the work belongs to the user
    const work = await prisma.work.findUnique({
      where: { id: workId },
      select: { 
        tenantEmail: true, 
        offerId: true,
        title: true 
      },
    });

    if (!work || work.tenantEmail !== tenantEmail) {
      return { success: false, error: "Unauthorized" };
    }

    // Get the offer to add the new item
    const offer = await prisma.offer.findUnique({
      where: { id: work.offerId },
      select: { 
        id: true, 
        items: true, 
        tenantEmail: true,
        totalPrice: true 
      },
    });

    if (!offer || offer.tenantEmail !== tenantEmail) {
      return { success: false, error: "Offer not found or unauthorized" };
    }

    // Parse existing offer items
    let existingItems = [];
    try {
      existingItems = offer.items ? JSON.parse(offer.items as string) : [];
    } catch (e) {
      existingItems = [];
    }

    // Helper function to calculate totals
    function calculateTotal(quantity: number, unitPrice: string): string {
      const qty = quantity || 0;
      const price = parseFloat(unitPrice.replace(/[^\d.-]/g, '')) || 0;
      const total = qty * price;
      return `${total.toLocaleString('hu-HU')} Ft`;
    }

    // Create new offer item (to be added at first position)
    const newOfferItem = {
      id: Date.now(), // Temporary ID
      name: itemData?.name || "Új tétel",
      quantity: itemData?.quantity?.toString() || "1",
      unit: itemData?.unit || "db",
      materialUnitPrice: itemData?.materialUnitPrice || "0 Ft",
      unitPrice: itemData?.unitPrice || "0 Ft",
      materialTotal: itemData ? calculateTotal(itemData.quantity, itemData.materialUnitPrice) : "0 Ft",
      workTotal: itemData ? calculateTotal(itemData.quantity, itemData.unitPrice) : "0 Ft",
    };

    // Add the new item at the beginning
    const updatedItems = [newOfferItem, ...existingItems];

    // Calculate totals for the updated items (following existing pattern)
    const totals = updatedItems.reduce(
      (acc, item) => {
        const material = parseFloat(
          item.materialTotal.replace(/[^0-9,-]+/g, "").replace(",", ".")
        ) || 0;
        const work = parseFloat(
          item.workTotal.replace(/[^0-9,-]+/g, "").replace(",", ".")
        ) || 0;
        return {
          material: acc.material + material,
          work: acc.work + work,
          grandTotal: acc.grandTotal + material + work,
        };
      },
      { material: 0, work: 0, grandTotal: 0 }
    );

    const { material: materialTotal, work: workTotal, grandTotal } = totals;

    // Update the offer with the new item (following existing updateOfferItems pattern)
    await prisma.offer.update({
      where: {
        id: offer.id,
        tenantEmail: tenantEmail, // Ensure we only update if the offer belongs to the user
      },
      data: {
        items: JSON.stringify(updatedItems),
        totalPrice: Math.round(grandTotal),
        materialTotal: Math.round(materialTotal),
        workTotal: Math.round(workTotal),
        updatedAt: new Date(),
      },
    });

    // Create new work item that matches the offer item (offer is source of truth)
    const materialUnitPriceNum = parseFloat(newOfferItem.materialUnitPrice.replace(/[^\d.-]/g, '')) || 0;
    const unitPriceNum = parseFloat(newOfferItem.unitPrice.replace(/[^\d.-]/g, '')) || 0;
    const quantityNum = parseInt(newOfferItem.quantity) || 1;

    const newWorkItem = await prisma.workItem.create({
      data: {
        workId: workId,
        name: newOfferItem.name, // Same name as offer item
        description: itemData?.name ? `${itemData.name} - munkaelem` : "Új munkaelem leírása",
        quantity: quantityNum, // Same quantity as offer item
        unit: newOfferItem.unit, // Same unit as offer item
        unitPrice: Math.round(unitPriceNum),
        materialUnitPrice: Math.round(materialUnitPriceNum),
        workTotal: Math.round(quantityNum * unitPriceNum),
        materialTotal: Math.round(quantityNum * materialUnitPriceNum),
        totalPrice: Math.round((quantityNum * unitPriceNum) + (quantityNum * materialUnitPriceNum)),
        tenantEmail: tenantEmail,
        progress: 0,
        completedQuantity: 0,
        inProgress: false,
      },
    });

    // Revalidate the tasks page
    revalidatePath(`/tasks/${workId}`);
    revalidatePath(`/offers/${offer.id}`);

    return { 
      success: true, 
      workItem: newWorkItem,
      offerItem: newOfferItem,
      message: "Új tétel és munkaelem sikeresen létrehozva!"
    };

  } catch (error) {
    console.error("Error adding work item and offer item:", error);
    return { 
      success: false, 
      error: "Hiba történt a tétel létrehozásakor" 
    };
  }
}
