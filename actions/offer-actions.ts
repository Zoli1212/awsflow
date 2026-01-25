"use server";

import { prisma } from "@/lib/prisma";
import { getTenantSafeAuth } from "@/lib/tenant-auth";
import { revalidatePath } from "next/cache";
import { Prisma, Offer } from "@prisma/client";
import { parseOfferText, formatOfferForSave } from "@/lib/offer-parser";
import { autoSyncOfferToRAG } from "./auto-rag-sync";
import {
  OfferItem,
  OfferItemQuestion,
  OfferWithItems,
} from "@/types/offer.types";
import { v4 as uuidv4 } from "uuid";

/**
 * 2-szintű árkeresés: TenantPriceList → PriceList (globális)
 * Ha egyik sincs, marad az eredeti ár
 * Visszaadja az új árakat + újraszámolt totálokat
 */
async function getOfferItemPrice(
  task: string,
  tenantEmail: string,
  originalLaborCost: number,
  originalMaterialCost: number,
  quantity: number
): Promise<{
  laborCost: number;
  materialCost: number;
  workTotal: number;
  materialTotal: number;
  totalPrice: number;
}> {
  try {
    let laborCost = originalLaborCost;
    let materialCost = originalMaterialCost;

    // Eltávolítjuk a csillagot a task névből, ha van (az AI csillaggal küldi vissza)
    const cleanedTask = task.replace(/^\*\s*/, "").trim();

    // 1. Tenant-specifikus ár keresése
    const tenantPrice = await prisma.tenantPriceList.findUnique({
      where: {
        tenant_task_unique: {
          task: cleanedTask,
          tenantEmail,
        },
      },
    });

    if (tenantPrice) {
      laborCost = tenantPrice.laborCost;
      materialCost = tenantPrice.materialCost;
    } else {
      // 2. Globális ár keresése
      const globalPrice = await prisma.priceList.findUnique({
        where: {
          task_tenantEmail: {
            task: cleanedTask,
            tenantEmail: "",
          },
        },
      });

      if (globalPrice) {
        laborCost = globalPrice.laborCost;
        materialCost = globalPrice.materialCost;
      }
    }

    // Újraszámolt totálok - kerekítve
    const workTotal = Math.round(quantity * laborCost);
    const materialTotal = Math.round(quantity * materialCost);
    const totalPrice = Math.round(workTotal + materialTotal);

    return {
      laborCost: Math.round(laborCost),
      materialCost: Math.round(materialCost),
      workTotal,
      materialTotal,
      totalPrice,
    };
  } catch (error) {
    console.error("Error looking up price for task:", task, error);
    // Fallback: eredeti árak + újraszámolt totálok - kerekítve
    const workTotal = Math.round(quantity * originalLaborCost);
    const materialTotal = Math.round(quantity * originalMaterialCost);
    const totalPrice = Math.round(workTotal + materialTotal);

    return {
      laborCost: Math.round(originalLaborCost),
      materialCost: Math.round(originalMaterialCost),
      workTotal,
      materialTotal,
      totalPrice,
    };
  }
}

// Using shared OfferWithItems type from @/types/offer.types

interface SaveOfferData {
  recordId?: string;
  demandText: string;
  offerContent: string;
  checkedItems?: OfferItem[];
  extraRequirementText?: string; // Optional: extra requirement text to save as a block
  blockIds?: number[]; // Block IDs to update with the new requirement
  offerItemsQuestion?: OfferItemQuestion[];
  requirementId?: number;
  offerTitle?: string;
  userEmail?: string; // Optional: for Inngest function calls (bypasses Clerk auth)
  incrementUpdateCount?: boolean; // Ha true, növeli az updateCount-ot (frontend), ha false/undefined, nem növeli (Inngest)
}

interface ParsedOfferContent {
  title?: string;
  location?: string;
  totalPrice?: number;
  items?: Array<{
    name: string;
    quantity: string;
    unit: string;
    unitPrice: string;
    materialUnitPrice: string;
    workTotal: string;
    materialTotal: string;
    totalPrice: string;
  }>;
  notes?: string[];
  offerSummary?: string;
}

export async function saveOfferWithRequirements(data: SaveOfferData) {
  try {
    const {
      recordId,
      demandText,
      offerContent,
      checkedItems,
      extraRequirementText,
      offerItemsQuestion, // Add default value and type annotation
      requirementId,
      offerTitle,
      userEmail: providedUserEmail, // Inngest function-ből jövő email
    }: SaveOfferData = data; // Add type annotation

    // Használjunk Prisma transaction-t a rollback biztosítására
    // Timeout növelve 30 másodpercre (sok item esetén szükséges)
    return await prisma.$transaction(
      async (tx) => {
        // ... rest of the code remains the same ...
        if (recordId) {
          const existingOffer = await tx.offer.findFirst({
            where: { recordId },
            select: {
              id: true,
              title: true,
              createdAt: true,
              requirement: {
                select: { id: true },
              },
            },
          });

          if (existingOffer) {
            console.warn("Offer with this recordId already exists:", {
              id: existingOffer.id,
              title: existingOffer.title,
              createdAt: existingOffer.createdAt,
            });
            return {
              success: true, // Change to true since the offer exists
              error: "",
              offerId: existingOffer.id,
              requirementId: existingOffer.requirement?.id || null,
            };
          }
        }

        // Parse the offer content (could be JSON or raw text)
        let parsedContent: ParsedOfferContent;
        try {
          parsedContent = JSON.parse(offerContent) as ParsedOfferContent;
        } catch (e) {
          // If not valid JSON, try to parse as raw text
          parsedContent = formatOfferForSave(parseOfferText(offerContent));
        }

        // Merge with checked items if they exist
        if (checkedItems && checkedItems.length > 0 && parsedContent.items) {
          // Egyedi kulcs csak a name és quantity alapján
          const createKey = (item: { name: string; quantity: string }) =>
            `${item.name}||${item.quantity}`;

          const checkedItemsMap = new Map(
            checkedItems.map((item) => [createKey(item), item])
          );

          const finalItems = parsedContent.items.map((originalItem) => {
            const key = createKey(originalItem);
            if (checkedItemsMap.has(key)) {
              const storeItem = checkedItemsMap.get(key)!;
              return { ...storeItem, totalPrice: storeItem.totalPrice ?? "0" };
            }
            return originalItem;
          });

          parsedContent.items = finalItems;
        }

        // If we have offerItemsQuestion, use it as the base and add any new items from parsedContent.items
        if (offerItemsQuestion && offerItemsQuestion.length > 0) {
          // Ensure all items in offerItemsQuestion have required properties with defaults
          const normalizedOfferItems = offerItemsQuestion.map((item) => ({
            name: item.name || "",
            quantity: item.quantity || "1",
            unit: item.unit || "db",
            unitPrice: item.workUnitPrice || "0",
            materialUnitPrice: item.materialUnitPrice || "0",
            workTotal: item.workTotal || "0",
            materialTotal: item.materialTotal || "0",
            totalPrice: item.totalPrice || "0",
          }));

          // Create a Set of item names from offerItemsQuestion for quick lookup
          const existingItemNames = new Set(
            normalizedOfferItems.map((item) => item.name)
          );

          // Add items from parsedContent.items that don't exist in offerItemsQuestion
          const newItems = (parsedContent.items || [])
            .filter(
              (item: { name?: string }) =>
                item?.name && !existingItemNames.has(item.name)
            )
            .map((item) => ({
              name: item.name || "",
              quantity: "quantity" in item ? item.quantity : "1",
              unit: "unit" in item ? item.unit : "db",
              unitPrice: "unitPrice" in item ? item.unitPrice : "0",
              materialUnitPrice:
                "materialUnitPrice" in item ? item.materialUnitPrice : "0",
              workTotal: "workTotal" in item ? item.workTotal : "0",
              materialTotal: "materialTotal" in item ? item.materialTotal : "0",
              totalPrice: "totalPrice" in item ? item.totalPrice : "0",
            }));

          // Combine the arrays (offerItemsQuestion first, then new items)
          parsedContent.items = [...normalizedOfferItems, ...newItems];
        }

        // Auth: ha providedUserEmail meg van adva (Inngest), akkor azt használjuk
        // Különben Clerk auth-ot használunk (frontend)
        let emailToUse: string;

        if (providedUserEmail) {
          // Inngest function hívás: nincs Clerk session, használjuk a provided email-t
          console.log("Using provided userEmail (Inngest):", providedUserEmail);
          emailToUse = providedUserEmail;
        } else {
          // Frontend hívás: Clerk auth
          console.log("Using Clerk auth (frontend)");
          const { tenantEmail } = await getTenantSafeAuth();
          emailToUse = tenantEmail;
        }

        // 2-szintű árkeresés és újraszámolás az items-hez (BATCH OPTIMALIZÁLVA)
        if (parsedContent.items && parsedContent.items.length > 0) {
          console.log("Processing items with BATCH price lookup...");

          // Tisztítsuk meg az összes task nevet egyszerre
          const cleanedTaskNames = parsedContent.items.map((item: any) =>
            item.name.replace(/^\*\s*/, "").trim()
          );

          // BATCH: Egyetlen lekérdezés az összes tenant-specifikus árhoz
          const tenantPrices = await tx.tenantPriceList.findMany({
            where: {
              task: { in: cleanedTaskNames },
              tenantEmail: emailToUse,
            },
          });

          // BATCH: Egyetlen lekérdezés az összes globális árhoz
          const globalPrices = await tx.priceList.findMany({
            where: {
              task: { in: cleanedTaskNames },
              tenantEmail: "",
            },
          });

          // Map-ek a gyors kereséshez
          const tenantPriceMap = new Map(
            tenantPrices.map((p) => [
              p.task,
              { laborCost: p.laborCost, materialCost: p.materialCost },
            ])
          );
          const globalPriceMap = new Map(
            globalPrices.map((p) => [
              p.task,
              { laborCost: p.laborCost, materialCost: p.materialCost },
            ])
          );

          // Feldolgozzuk az items-t a batch adatokkal
          const processedItems = parsedContent.items.map((item: any) => {
            const quantity = parseFloat(item.quantity) || 1;
            let laborCost = parseFloat(item.unitPrice) || 0;
            let materialCost = parseFloat(item.materialUnitPrice) || 0;

            const cleanedTask = item.name.replace(/^\*\s*/, "").trim();

            // Cascade: tenant → global → eredeti
            const tenantPrice = tenantPriceMap.get(cleanedTask);
            const globalPrice = globalPriceMap.get(cleanedTask);

            if (tenantPrice) {
              laborCost = tenantPrice.laborCost;
              materialCost = tenantPrice.materialCost;
            } else if (globalPrice) {
              laborCost = globalPrice.laborCost;
              materialCost = globalPrice.materialCost;
            }

            // Újraszámolt totálok - kerekítve
            const workTotal = Math.round(quantity * laborCost);
            const materialTotal = Math.round(quantity * materialCost);
            const totalPrice = Math.round(workTotal + materialTotal);

            return {
              ...item,
              unitPrice: Math.round(laborCost).toString(),
              materialUnitPrice: Math.round(materialCost).toString(),
              workTotal: workTotal.toString(),
              materialTotal: materialTotal.toString(),
              totalPrice: totalPrice.toString(),
            };
          });

          parsedContent.items = processedItems;
          console.log(
            `Items processed with BATCH price lookup (${cleanedTaskNames.length} items, 2 queries instead of ${cleanedTaskNames.length * 2})`
          );
        }

        // Újraszámoljuk a totalPrice, materialTotal és workTotal értékeket az items alapján
        let calculatedTotalPrice = 0;
        let calculatedMaterialTotal = 0;
        let calculatedWorkTotal = 0;

        if (parsedContent.items && parsedContent.items.length > 0) {
          const totals = parsedContent.items.reduce(
            (acc, item: any) => {
              const materialTotal = parseFloat(item.materialTotal) || 0;
              const workTotal = parseFloat(item.workTotal) || 0;
              return {
                material: acc.material + materialTotal,
                work: acc.work + workTotal,
                total: acc.total + materialTotal + workTotal,
              };
            },
            { material: 0, work: 0, total: 0 }
          );

          calculatedMaterialTotal = Math.round(totals.material);
          calculatedWorkTotal = Math.round(totals.work);
          calculatedTotalPrice = Math.round(totals.total);

          console.log("Calculated totals from items:", {
            materialTotal: calculatedMaterialTotal,
            workTotal: calculatedWorkTotal,
            totalPrice: calculatedTotalPrice,
          });
        }

        // Extract title, customer name, and time from offer content
        let title = "Új ajánlat";
        let customerName = "Ügyfél";
        let estimatedTime = "00:00";

        const lines = offerContent
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line);

        // Get title from line starting with #
        const titleLine = lines.find((line) => line.startsWith("#"));
        if (titleLine) {
          title = titleLine.substring(1).trim();
        } else if (parsedContent.title) {
          title = parsedContent.title;
        }

        // Get customer name from line starting with 'Kedves'
        const greetingLine = lines.find((line) => line.startsWith("Kedves"));
        if (greetingLine) {
          // Extract the name after 'Kedves' and before '!'
          const nameMatch = greetingLine.match(/Kedves\s+([^!]+)/);
          if (nameMatch && nameMatch[1]) {
            customerName = nameMatch[1].trim();
          }
        }

        // Get estimated time from line containing 'Becsült kivitelezési idő:'
        const timeLine = lines.find((line) =>
          line.includes("Becsült kivitelezési idő:")
        );
        if (timeLine) {
          const timeMatch = timeLine.match(
            /Becsült kivitelezési idő:\s*([\d-]+)\s*nap/
          );
          if (timeMatch && timeMatch[1]) {
            estimatedTime = timeMatch[1].trim() + " nap";
          }
        }

        // 1. Check if work with this title already exists
        const existingWork = await tx.myWork.findFirst({
          where: {
            title,
            tenantEmail: emailToUse,
          },
          select: {
            id: true,
            title: true,
          },
        });

        let work;

        // RÉGI LOGIKA - kikommentelve
        // if (existingWork) {
        //   // Use existing work
        //   console.log(existingWork, "EXISTINGWORK");
        //   work = existingWork;
        // } else {
        //   const finalTitle = title && title.trim() !== "" ? title : uuidv4();
        //   // Create new work record if it doesn't exist
        //   work = await tx.myWork.create({
        //     data: {
        //       title: finalTitle,
        //       customerName,
        //       date: new Date(),
        //       location: title || parsedContent.location || "Nincs megadva",
        //       time: estimatedTime,
        //       totalPrice: parsedContent.totalPrice || 0,
        //       tenantEmail: emailToUse,
        //     } as Prisma.MyWorkCreateInput,
        //   });
        // }

        // ÚJ LOGIKA - mindig új munkát hoz létre, számozással ha már létezik
        let finalTitle = title && title.trim() !== "" ? title : uuidv4();

        if (existingWork) {
          // Ha létezik már ilyen című munka, számozzuk meg
          let counter = 2;
          let uniqueTitle = `${title} (${counter})`;

          // Keressünk szabad számot
          while (
            await tx.myWork.findFirst({
              where: { title: uniqueTitle, tenantEmail: emailToUse },
            })
          ) {
            counter++;
            uniqueTitle = `${title} (${counter})`;
          }

          finalTitle = uniqueTitle;
          console.log(
            `Work with title "${title}" exists, creating new with title: ${finalTitle}`
          );
        }

        // Mindig CREATE (soha nem használja a meglévőt)
        work = await tx.myWork.create({
          data: {
            title: finalTitle,
            customerName,
            date: new Date(),
            location: title || parsedContent.location || "Nincs megadva",
            time: estimatedTime,
            totalPrice: parsedContent.totalPrice || 0,
            tenantEmail: emailToUse,
          } as Prisma.MyWorkCreateInput,
        });

        // 2. Create or update Requirement with versioning
        const requirementTitle =
          `Követelmény - ${work.title}` ||
          customerName ||
          parsedContent.title ||
          "Új ajánlat";

        // Find the latest version of this requirement
        let latestRequirement = null;
        if (requirementId) {
          latestRequirement = await tx.requirement.findUnique({
            where: { id: requirementId },
            select: {
              versionNumber: true,
              id: true,
              updateCount: true,
              questionCount: true,
            },
          });
        }
        if (!latestRequirement) {
          latestRequirement = await tx.requirement.findFirst({
            where: {
              title: requirementTitle,
              myWorkId: work.id,
            },
            orderBy: { versionNumber: "desc" },
            select: {
              versionNumber: true,
              id: true,
              updateCount: true,
              questionCount: true,
            },
          });
        }

        const newVersionNumber = latestRequirement
          ? latestRequirement.versionNumber + 1
          : 1;

        // If we have a previous requirement (from requirementId), increment its values
        // Otherwise, start from defaults
        let newUpdateCount: number;
        let newQuestionCount: number;

        if (latestRequirement && requirementId) {
          // We have a previous requirement, increment its values
          newUpdateCount = latestRequirement.updateCount + 1;
          newQuestionCount = 1; // User válaszolt a kérdésekre, így questionCount = 1
        } else {
          // First requirement, use defaults
          newUpdateCount = 1;
          newQuestionCount = 0; // Kérdések látszanak
        }

        console.log("=== REQUIREMENT VERSION INFO ===");
        console.log("latestRequirement:", latestRequirement);
        console.log("requirementId (provided):", requirementId);
        console.log("newVersionNumber:", newVersionNumber);
        console.log("newUpdateCount:", newUpdateCount);
        console.log("newQuestionCount:", newQuestionCount);
        console.log("work.title:", work.title);
        console.log("================================");

        // Prepare requirement data
        const requirementData = {
          title: requirementTitle,
          description: demandText || "Ingatlan felújítási kérelem",
          versionNumber: newVersionNumber,
          status: "draft",
          myWork: {
            connect: { id: work.id },
          },
          updateCount: newUpdateCount,
          questionCount: newQuestionCount,
          // Link to previous version if it exists
          ...(latestRequirement && {
            previousVersion: {
              connect: { id: latestRequirement.id },
            },
          }),
        };

        console.log(
          "Creating requirement with data:",
          JSON.stringify(requirementData, null, 2)
        );

        // Create new version of the requirement
        const requirement = await tx.requirement.create({
          data: requirementData as Prisma.RequirementCreateInput,
        });

        // Update the previous version to point to this new version
        if (latestRequirement) {
          await tx.requirement.update({
            where: { id: latestRequirement.id },
            data: {
              nextVersions: {
                connect: { id: requirement.id },
              },
            },
          });
        }

        // 3. Update existing blocks to point to the new requirement
        if (data.blockIds && data.blockIds.length > 0) {
          console.log(
            `Updating ${data.blockIds.length} blocks to point to new requirement ${requirement.id}`
          );

          // Update all blocks to point to the new requirement
          try {
            await tx.requirementItemsBlock.updateMany({
              where: { id: { in: data.blockIds } },
              data: { requirementId: requirement.id },
            });
            console.log(
              `Successfully updated ${data.blockIds.length} blocks to requirement ${requirement.id}`
            );
          } catch (error) {
            console.error("Error updating block references:", error);
            throw error; // Transaction rollback
          }
        }

        // 4. Save extra requirement text as a block if it exists
        if (extraRequirementText?.trim()) {
          try {
            await tx.requirementItemsBlock.create({
              data: {
                requirementId: requirement.id,
                blockText: extraRequirementText.trim(),
              },
            });
            console.log("Extra requirement text saved as block");
          } catch (error) {
            console.error("Error saving extra requirement block:", error);
            throw error; // Transaction rollback
          }
        }

        // 4. Create the Offer with the parsed content
        console.log("Preparing to create offer with recordId:", recordId);

        // Format notes for description if they exist, but exclude offerSummary
        let filteredNotes = parsedContent.notes || [];
        if (filteredNotes.length > 0) {
          console.log("Original notes:", filteredNotes);
          // Remove offerSummary lines from notes
          filteredNotes = filteredNotes.filter(
            (note) => !note.toLowerCase().startsWith("offersummary:")
          );
          console.log("Filtered notes (without offerSummary):", filteredNotes);
        }

        const formattedNotes =
          filteredNotes.length > 0
            ? filteredNotes.join("\n\n")
            : "Nincsenek megjegyzések";

        const offerData: any = {
          title: offerTitle || work.title,
          description: formattedNotes, // Save formatted notes in the description
          totalPrice: calculatedTotalPrice || parsedContent.totalPrice || 0, // Use calculated total from items
          materialTotal: calculatedMaterialTotal || 0, // Use calculated material total from items
          workTotal: calculatedWorkTotal || 0, // Use calculated work total from items
          status: "draft",
          requirement: {
            connect: { id: requirement.id },
          },
          validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
          createdBy: emailToUse,
          tenantEmail: emailToUse, // Add tenantEmail to ensure it's saved with the offer
          offerSummary: parsedContent.offerSummary || null, // Save the AI-generated summary
        };

        // Add recordId if it exists
        if (recordId) {
          offerData.recordId = recordId;
        }

        // Log the data we're about to save
        console.log("Offer data to be saved:", {
          title: offerData.title,
          totalPrice: offerData.totalPrice,
          requirementId: requirement.id,
          hasRecordId: !!recordId,
          recordId: recordId || "N/A",
          hasItems: !!(parsedContent.items && parsedContent.items.length > 0),
          itemCount: parsedContent.items?.length || 0,
          hasNotes: !!(parsedContent.notes && parsedContent.notes.length > 0),
          noteCount: parsedContent.notes?.length || 0,
          descriptionPreview: formattedNotes.substring(0, 100) + "...",
          hasOfferSummary: !!parsedContent.offerSummary,
          offerSummaryPreview: parsedContent.offerSummary
            ? parsedContent.offerSummary.substring(0, 100) + "..."
            : "N/A",
        });

        // Add items if they exist
        if (parsedContent.items && parsedContent.items.length > 0) {
          // Process items: add "new": true for items with ! and remove the !
          // All other items get "new": false
          const processedItems = parsedContent.items.map((item: any) => {
            if (item.name && item.name.endsWith("!")) {
              return {
                ...item,
                name: item.name.slice(0, -1), // Remove the ! from the end
                new: true,
              };
            }
            return {
              ...item,
              new: false, // Explicitly set new: false for all non-custom items
            };
          });

          offerData.items = processedItems as unknown as Prisma.InputJsonValue;
        } else {
          offerData.items = [] as unknown as Prisma.InputJsonValue; // Ensure it's a valid empty array
        }

        // Add notes as STRING if they exist (notes is String? type, not Json)
        if (parsedContent.notes && parsedContent.notes.length > 0) {
          offerData.notes = parsedContent.notes.join("\n\n");
        }

        try {
          // Check if an offer already exists for this requirement or recordId
          const existingOfferForUpdate = await tx.offer.findFirst({
            where: {
              OR: [
                { requirementId: requirement.id },
                ...(recordId ? [{ recordId }] : []),
              ],
            },
            select: {
              id: true,
              title: true,
              createdAt: true,
            },
          });

          let offer;

          if (existingOfferForUpdate) {
            // UPDATE existing offer to prevent duplicates
            console.log("Updating existing offer:", {
              id: existingOfferForUpdate.id,
              title: existingOfferForUpdate.title,
              createdAt: existingOfferForUpdate.createdAt,
            });

            offer = await tx.offer.update({
              where: { id: existingOfferForUpdate.id },
              data: offerData,
              select: {
                id: true,
                title: true,
                description: true,
                createdAt: true,
                items: true,
                notes: true,
                offerSummary: true,
              },
            });

            console.log("Offer updated successfully:", {
              id: offer.id,
              title: offer.title,
              recordId: recordId || "N/A",
              createdAt: offer.createdAt,
              hasItems: !!offer.items,
              hasNotes: !!offer.notes,
              hasOfferSummary: !!offer.offerSummary,
              offerSummary: offer.offerSummary || "N/A",
            });
          } else {
            // CREATE new offer
            console.log("Creating new offer");

            offer = await tx.offer.create({
              data: offerData,
              select: {
                id: true,
                title: true,
                description: true,
                createdAt: true,
                items: true,
                notes: true,
                offerSummary: true,
              },
            });

            console.log("Offer created successfully:", {
              id: offer.id,
              title: offer.title,
              recordId: recordId || "N/A",
              createdAt: offer.createdAt,
              hasItems: !!offer.items,
              hasNotes: !!offer.notes,
              hasOfferSummary: !!offer.offerSummary,
              offerSummary: offer.offerSummary || "N/A",
            });
          }

          revalidatePath("/jobs");
          revalidatePath("/offers");

          // Automatikus RAG szinkronizáció (háttérben, de transaction-ön kívül)
          // RAG hiba nem okozhat rollback-et
          // KIKOMMENTELVE: Inngest function-ből hívva nincs Clerk session context
          // Promise.resolve().then(async () => {
          //   try {
          //     await autoSyncOfferToRAG(offer.id);
          //     console.log(
          //       `✅ RAG automatikusan szinkronizálva ajánlathoz: ${offer.id}`
          //     );
          //   } catch (ragError) {
          //     console.error(
          //       `❌ RAG szinkronizáció hiba ajánlathoz ${offer.id}:`,
          //       ragError
          //     );
          //   }
          // });

          return {
            success: true,
            workId: work.id,
            requirementId: requirement.id,
            offerId: offer.id,
            title: work.title,
          };
        } catch (error) {
          console.error("Error creating offer:", error);
          throw new Error("Hiba történt az ajánlat mentésekor");
        }
      },
      {
        timeout: 8000, // 8 másodperc timeout (Vercel Hobby limit: 10s)
      }
    ); // Transaction vége
  } catch (error) {
    console.error("Error saving offer with requirements:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Hiba történt az ajánlat mentésekor",
    };
  }
}

export async function getUserOffers() {
  try {
    const { user, tenantEmail: userEmail } = await getTenantSafeAuth();

    // First, get all works for the current user
    const works = await prisma.myWork.findMany({
      where: {
        tenantEmail: userEmail,
      },
      include: {
        requirements: {
          include: {
            offers: {
              include: {
                work: {
                  select: {
                    id: true,
                    processingByAI: true,
                    updatedByAI: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Flatten the offers array from all requirements
    const offers = works.flatMap((work) =>
      work.requirements.flatMap((req) =>
        req.offers.map((offer) => ({
          ...offer,
          requirement: {
            id: req.id,
            title: req.title,
          },
        }))
      )
    );

    // Process items and notes for each offer
    return offers.map((offer) => ({
      ...offer,
      items: offer.items
        ? Array.isArray(offer.items)
          ? offer.items
          : JSON.parse(offer.items as string)
        : [],
      notes: offer.notes
        ? Array.isArray(offer.notes)
          ? offer.notes
          : [offer.notes as string]
        : [],
    }));
  } catch (error) {
    console.error("Error fetching user offers:", error);
    throw new Error("Failed to fetch user offers");
  }
}

export async function getOfferById(id: number) {
  try {
    const { user, tenantEmail: userEmail } = await getTenantSafeAuth();
    console.log(`Fetching offer with ID: ${id} for user: ${userEmail}`);

    const offer = await prisma.offer.findFirst({
      where: {
        id,
        tenantEmail: userEmail,
      },
      include: {
        requirement: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
          },
        },
      },
    });

    if (!offer) {
      console.log(`No offer found with ID: ${id} for user: ${userEmail}`);
      return null;
    }

    // Parse items and notes if they exist
    const items = ((offer.items as any) || []).map((item: any) => {
      const quantity = parseFloat(item.quantity) || 0;
      const unitPrice = Math.round(parseFloat(item.unitPrice) || 0); // This is work unit price
      const materialUnitPrice = Math.round(parseFloat(item.materialUnitPrice) || 0);

      // Calculate totals, ensuring they are numbers - kerekítve
      const workTotal = Math.round(quantity * unitPrice);
      const materialTotal = Math.round(quantity * materialUnitPrice);
      const totalPrice = Math.round(workTotal + materialTotal);

      return {
        ...item,
        quantity,
        unitPrice, // Munkadíj egységár
        materialUnitPrice, // Anyag egységár
        workTotal, // Munkadíj összesen
        materialTotal, // Anyagköltség összesen
        totalPrice, // Teljes ár (munkadíj + anyag)
      };
    });
    const notes = offer.notes ? offer.notes.split("\n\n") : [];

    // Log the parsed data for debugging
    console.log("Parsed offer data:", {
      id: offer.id,
      title: offer.title,
      itemsCount: items.length,
      notesCount: notes.length,
      hasRequirement: !!offer.requirement,
    });

    return {
      ...offer,
      items,
      notes,
    };
  } catch (error) {
    console.error("Error in getOfferById:", error);
    throw new Error("Hiba történt az ajánlat betöltésekor");
  }
}

export async function updateOfferItems(offerId: number, items: OfferItem[]) {
  try {
    const { user, tenantEmail: userEmail } = await getTenantSafeAuth();
    console.log(
      `Updating items for offer ID: ${offerId} for user: ${userEmail}`,
      items
    );

    // First, verify the offer belongs to the current user and get its status
    const existingOffer = await prisma.offer.findFirst({
      where: {
        id: offerId,
        tenantEmail: userEmail,
      },
      select: {
        id: true,
        status: true,
        items: true,
      },
    });

    if (!existingOffer) {
      throw new Error(
        "Az ajánlat nem található vagy nincs jogosultságod a módosításához!"
      );
    }

    // Parse existing items to compare with new items
    const existingItems = existingOffer.items
      ? Array.isArray(existingOffer.items)
        ? existingOffer.items
        : JSON.parse(existingOffer.items as string)
      : [];

    // If offer is in 'work' status, we need to sync work items
    if (existingOffer.status === "work") {
      // Find the corresponding work
      const work = await prisma.work.findFirst({
        where: { offerId: offerId },
        select: { id: true },
      });

      if (work) {
        // Get existing work items
        const existingWorkItems = await prisma.workItem.findMany({
          where: { workId: work.id },
          select: { id: true, name: true, quantity: true },
        });

        // Find items that were deleted (exist in old items but not in new items)
        const deletedItems = existingItems.filter(
          (existingItem: any) =>
            !items.some((newItem) => newItem.id === existingItem.id)
        );

        // Delete corresponding work items
        for (const deletedItem of deletedItems) {
          const workItemToDelete = existingWorkItems.find(
            (wi) =>
              wi.name === deletedItem.name &&
              wi.quantity === parseInt(deletedItem.quantity)
          );
          if (workItemToDelete) {
            await prisma.workItem.delete({
              where: { id: workItemToDelete.id },
            });
            console.log(`Deleted work item: ${workItemToDelete.name}`);
          }
        }

        // Find new items (exist in new items but not in old items)
        const newItems = items.filter(
          (newItem) =>
            !existingItems.some(
              (existingItem: any) => existingItem.id === newItem.id
            )
        );

        // Create corresponding work items for new items
        for (const newItem of newItems) {
          const materialUnitPriceNum =
            parseFloat(newItem.materialUnitPrice.replace(/[^\d.-]/g, "")) || 0;
          const unitPriceNum =
            parseFloat(newItem.unitPrice.replace(/[^\d.-]/g, "")) || 0;
          const quantityNum = parseInt(newItem.quantity) || 1;

          await prisma.workItem.create({
            data: {
              workId: work.id,
              name: newItem.name,
              description: `${newItem.name} - munkaelem`,
              quantity: quantityNum,
              unit: newItem.unit,
              unitPrice: Math.round(unitPriceNum),
              materialUnitPrice: Math.round(materialUnitPriceNum),
              workTotal: Math.round(quantityNum * unitPriceNum),
              materialTotal: Math.round(quantityNum * materialUnitPriceNum),
              totalPrice: Math.round(
                quantityNum * unitPriceNum + quantityNum * materialUnitPriceNum
              ),
              tenantEmail: userEmail,
              progress: 0,
              completedQuantity: 0,
              inProgress: false,
            },
          });
          console.log(`Created work item: ${newItem.name}`);
        }
      }
    }

    // Calculate new totals
    const totals = items.reduce(
      (acc, item) => {
        const material =
          typeof item.materialTotal === "string"
            ? parseFloat(
                item.materialTotal.replace(/[^0-9,-]+/g, "").replace(",", ".")
              ) || 0
            : parseFloat(String(item.materialTotal)) || 0;
        const work =
          typeof item.workTotal === "string"
            ? parseFloat(
                item.workTotal.replace(/[^0-9,-]+/g, "").replace(",", ".")
              ) || 0
            : parseFloat(String(item.workTotal)) || 0;
        return {
          material: acc.material + material,
          work: acc.work + work,
          grandTotal: acc.grandTotal + material + work,
        };
      },
      { material: 0, work: 0, grandTotal: 0 }
    );

    const { material: materialTotal, work: workTotal, grandTotal } = totals;

    // Process items: add "new": true for items with ! and remove the !
    // Also preserve the "new" field if it already exists
    const processedItems = items.map((item: any) => {
      const result: any = { ...item };

      // If item name ends with !, remove it and set new: true
      if (item.name && item.name.endsWith("!")) {
        result.name = item.name.slice(0, -1); // Remove the ! from the end
        result.new = true;
      }
      // If the item already has new field, preserve it
      else if (item.new) {
        result.new = true;
      }

      return result;
    });

    // Update the offer with new items and total price
    const updatedOffer = await prisma.offer.update({
      where: {
        id: offerId,
        tenantEmail: userEmail, // Ensure we only update if the offer belongs to the user
      },
      data: {
        items: processedItems as unknown as Prisma.InputJsonValue, // Type-safe JSON serialization
        totalPrice: Math.round(grandTotal),
        materialTotal: Math.round(materialTotal),
        workTotal: Math.round(workTotal),
        updatedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        totalPrice: true,
        items: true,
        updatedAt: true,
      },
    });

    console.log("✅ Offer items updated successfully:", {
      id: updatedOffer.id,
      title: updatedOffer.title,
      totalPrice: updatedOffer.totalPrice,
      itemCount: items.length,
      updatedAt: updatedOffer.updatedAt,
    });

    // Revalidate the offers page to show updated data
    revalidatePath("/offers");

    return {
      success: true,
      offer: {
        ...updatedOffer,
        items: (() => {
          try {
            let items: any[] = [];
            if (Array.isArray(updatedOffer.items)) {
              items = updatedOffer.items;
            } else if (typeof updatedOffer.items === "string") {
              items = JSON.parse(updatedOffer.items);
            }

            // Validate and transform each item to match OfferItem
            return items.map((item) => {
              const transformedItem: any = {
                id: item.id,
                name: item.name ? item.name.replace(/^\*+\s*/, "") : "",
                quantity: item.quantity || "0",
                unit: item.unit || "db",
                materialUnitPrice: item.materialUnitPrice || "0",
                unitPrice: item.unitPrice || "0",
                materialTotal: item.materialTotal || "0",
                workTotal: item.workTotal || "0",
                description: item.description || "",
              };

              // Explicitly preserve the new field for custom items
              if (item.new === true || item.new === "true") {
                transformedItem.new = true;
              } else {
                transformedItem.new = false;
              }

              return transformedItem as OfferItem;
            });
          } catch (error) {
            console.error("Error parsing offer items:", error);
            return [];
          }
        })(),
      },
    };
  } catch (error) {
    console.error("Error updating offer items:", error);
    return {
      success: false,
      error: "Hiba történt az ajánlat frissítésekor",
    };
  }
}

export async function updateOfferValidUntil(offerId: number, validUntil: Date) {
  try {
    const { user, tenantEmail } = await getTenantSafeAuth();

    // Verify the offer belongs to the current user
    const existingOffer = await prisma.offer.findFirst({
      where: {
        id: offerId,
        tenantEmail: tenantEmail,
      },
      select: { id: true, title: true },
    });

    if (!existingOffer) {
      return {
        success: false,
        error:
          "Az ajánlat nem található vagy nincs jogosultságod a módosításához!",
      };
    }

    // Update the validUntil field
    const updatedOffer = await prisma.offer.update({
      where: {
        id: offerId,
        tenantEmail: tenantEmail,
      },
      data: {
        validUntil: validUntil,
        updatedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        validUntil: true,
        updatedAt: true,
      },
    });

    console.log("✅ Offer validUntil updated successfully:", {
      id: updatedOffer.id,
      title: updatedOffer.title,
      validUntil: updatedOffer.validUntil,
      updatedAt: updatedOffer.updatedAt,
    });

    // Revalidate the offers page to show updated data
    revalidatePath("/offers");
    revalidatePath(`/offers/${offerId}`);
    revalidatePath(`/(dashboard)/offers`);
    revalidatePath(`/(dashboard)/offers/${offerId}`);
    revalidatePath(`/(dashboard)/offers/[requirementId]`);

    return {
      success: true,
      offer: updatedOffer,
    };
  } catch (error) {
    console.error("Error updating offer validUntil:", error);
    return {
      success: false,
      error: "Hiba történt az érvényességi dátum frissítésekor",
    };
  }
}

export async function updateOfferTitle(offerId: number, title: string) {
  try {
    const { user, tenantEmail } = await getTenantSafeAuth();
    console.log(user);

    // Verify the offer belongs to the current user
    const existingOffer = await prisma.offer.findFirst({
      where: {
        id: offerId,
        tenantEmail: tenantEmail,
      },
      select: { id: true },
    });

    if (!existingOffer) {
      return {
        success: false,
        error:
          "Az ajánlat nem található vagy nincs jogosultságod a módosításához!",
      };
    }

    // Update the title field
    const updatedOffer = await prisma.offer.update({
      where: {
        id: offerId,
        tenantEmail: tenantEmail,
      },
      data: {
        title: title,
        updatedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        updatedAt: true,
      },
    });

    console.log("✅ Offer title updated successfully:", {
      id: updatedOffer.id,
      title: updatedOffer.title,
    });

    // Revalidate the offers page to show updated data
    revalidatePath("/offers");
    revalidatePath(`/offers/${offerId}`);
    revalidatePath(`/(dashboard)/offers`);
    revalidatePath(`/(dashboard)/offers/${offerId}`);
    revalidatePath(`/(dashboard)/offers/[requirementId]`);

    return {
      success: true,
      offer: updatedOffer,
    };
  } catch (error) {
    console.error("Error updating offer title:", error);
    return {
      success: false,
      error: "Hiba történt a cím frissítésekor",
    };
  }
}

export async function updateOfferStatus(offerId: number, status: string) {
  console.log(
    "\n💾 [DB - updateOfferStatus] 1. Kezdés - offerId:",
    offerId,
    "status:",
    status
  );
  try {
    console.log("💾 [DB - updateOfferStatus] 2. Auth ellenőrzés...");
    const { user, tenantEmail } = await getTenantSafeAuth();
    console.log("💾 [DB - updateOfferStatus] 3. Tenant email:", tenantEmail);

    // 1. Ellenőrizzük, hogy létezik-e már work ehhez az ajánlathoz
    console.log("💾 [DB - updateOfferStatus] 4. Meglévő work keresése...");
    const existingWork = await prisma.work.findFirst({
      where: { offerId },
    });
    console.log(
      "💾 [DB - updateOfferStatus] 5. Meglévő work:",
      existingWork ? `ID: ${existingWork.id}` : "nincs"
    );

    // 2. Lekérjük az ajánlatot a requirementtel együtt
    console.log("💾 [DB - updateOfferStatus] 6. Offer lekérése...");
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        requirement: {},
      },
    });
    console.log(
      "💾 [DB - updateOfferStatus] 7. Offer lekérve:",
      offer ? `Title: ${offer.title}` : "nincs"
    );

    if (!offer) {
      console.error("❌ [DB - updateOfferStatus] 8. Offer nem található!");
      return { success: false, message: "Az ajánlat nem található!" };
    }

    // 3.5. estimatedDuration az Offer-ből (munkába állítás esetén, új work létrehozásakor)
    let estimatedDuration = "0";
    if (status === "work" && !existingWork) {
      // Az ajánlat létrehozásakor az AI már megbecsülte az időtartamot
      const offerWithDuration = offer as any;
      estimatedDuration = offerWithDuration.estimatedDuration || "0";
      console.log(
        "📋 [OFFER] estimatedDuration az ajánlatból:",
        estimatedDuration
      );
      console.log("📋 [OFFER] offer objektum:", JSON.stringify(offer, null, 2));
    }

    // 4. Tranzakció kezdete
    console.log("💾 [DB - updateOfferStatus] 9. TRANZAKCIÓ KEZDÉSE...");
    const result = await prisma.$transaction(
      async (tx) => {
        // 4.1. Frissítjük az ajánlat státuszát
        console.log(
          "💾 [DB - updateOfferStatus] 10. Offer status frissítése..."
        );
        const updatedOffer = await tx.offer.update({
          where: { id: offerId },
          data: {
            status,
            updatedAt: new Date(),
          },
        });
        console.log(
          "💾 [DB - updateOfferStatus] 11. Offer status frissítve:",
          updatedOffer.status
        );

        // 4.2. Munka státusz logika (logikai törlés/aktiválás)
        let workIdToProcess: number | null = null;

        if (status === "work") {
          console.log(
            "💾 [DB - updateOfferStatus] 12. Work létrehozás/aktiválás..."
          );
          if (existingWork) {
            console.log(
              "💾 [DB - updateOfferStatus] 13. Meglévő work aktiválása:",
              existingWork.id
            );
            // Ha már van work, csak aktiváljuk és beállítjuk a processingByAI-t
            await tx.work.update({
              where: { id: existingWork.id },
              data: { isActive: true, processingByAI: true },
            });
            workIdToProcess = existingWork.id;
            console.log(
              "💾 [DB - updateOfferStatus] 14. Work aktiválva, processingByAI=true"
            );
          } else {
            console.log(
              "💾 [DB - updateOfferStatus] 13. Új work létrehozása..."
            );
            // Ha nincs, mindig létrehozzuk
            const workTitle = offer.title || "Új munka";
            console.log(
              "💾 [DB - updateOfferStatus] 14. Work adatok előkészítése:",
              { workTitle, tenantEmail, estimatedDuration }
            );

            const newWork = await tx.work.create({
              data: {
                offerId: updatedOffer.id,
                status: "pending",
                title: workTitle,
                offerDescription: offer.description || null,
                location: offer.title || "N/A",
                totalWorkers: 0,
                totalLaborCost: 0,
                totalTools: 0,
                totalToolCost: 0,
                totalMaterials: 0,
                totalMaterialCost: offer.materialTotal
                  ? Number(offer.materialTotal)
                  : 0,
                estimatedDuration: estimatedDuration,
                progress: 0,
                tenantEmail: tenantEmail,
                offerItems: offer.items
                  ? JSON.parse(JSON.stringify(offer.items))
                  : null,
                isActive: true,
                processingByAI: true,
              },
            });
            workIdToProcess = newWork.id;
            console.log(
              "💾 [DB - updateOfferStatus] 15. Új work létrehozva, ID:",
              newWork.id
            );
          }
        } else if (status === "draft" && existingWork) {
          console.log(
            "💾 [DB - updateOfferStatus] 12. Draft-ra állítás, work inaktiválása..."
          );
          // Ellenőrizzük, hogy vannak-e naplóbejegyzések
          const hasDiaryEntries =
            (await tx.workDiary.count({
              where: { workId: existingWork.id },
            })) > 0;

          if (hasDiaryEntries) {
            // HA VAN NAPLÓ → NEM lehet draft-ra állítani! (munka már folyamatban)
            console.error(
              "❌ [DB - updateOfferStatus] 13. Work-nak vannak napló bejegyzései!"
            );
            throw new Error(
              "Nem állítható vissza draft-ra, mert már vannak naplóbejegyzések! A munka folyamatban van."
            );
          }

          // Ha nincs napló, akkor inaktiválhatjuk
          await tx.work.update({
            where: { id: existingWork.id },
            data: { isActive: false },
          });
          console.log("💾 [DB - updateOfferStatus] 13. Work inaktiválva");
        }

        console.log(
          "💾 [DB - updateOfferStatus] 16. Tranzakció return, workIdToProcess:",
          workIdToProcess
        );
        return { updatedOffer, workIdToProcess };
      },
      {
        timeout: 8000, // 8 másodperc timeout (Vercel Hobby limit: 10s)
      }
    );
    console.log("💾 [DB - updateOfferStatus] 17. TRANZAKCIÓ SIKERES!");

    // 5. processingByAI flag már be van állítva a tranzakcióban
    // A kliens oldal fogja meghívni az /api/start-work endpoint-ot

    // 6. Cache frissítése
    console.log("💾 [DB - updateOfferStatus] 18. Cache frissítése...");
    revalidatePath(`/dashboard/offers/${offerId}`);
    revalidatePath("/dashboard/offers");
    revalidatePath("/works");
    console.log("💾 [DB - updateOfferStatus] 19. Cache frissítve");

    console.log(
      "💾 [DB - updateOfferStatus] 20. ✅ SIKERES BEFEJEZÉS, workId:",
      result.workIdToProcess
    );
    return {
      success: true,
      message: `Az ajánlat sikeresen ${status === "work" ? "munkába állítva" : "frissítve"}!`,
      offer: result.updatedOffer,
      workId: result.workIdToProcess, // Visszaadjuk a workId-t a kliens számára
    };
  } catch (error) {
    console.error("Hiba az állapot frissítésekor:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Ismeretlen hiba történt az állapot frissítésekor",
    };
  }
}

/**
 * Vállalkozói szintű ár mentése - amikor az offer-detail-mobile-ban módosítják az árakat
 * Vállalkozói szint = tenant-specifikus ár a TenantPriceList-ben
 */
export async function saveTenantPrice(
  task: string,
  category: string | null,
  technology: string | null,
  unit: string | null,
  laborCost: number,
  materialCost: number
) {
  try {
    // Tisztítsd meg a task nevet a * karaktertől
    const cleanedTask = task.replace(/^\*+\s*/, "").trim();

    // Tenant email lekérése
    const { tenantEmail } = await getTenantSafeAuth();

    console.log("saveTenantPrice meghívva:", {
      originalTask: task,
      cleanedTask,
      tenantEmail,
      category,
      technology,
      unit,
      laborCost,
      materialCost,
    });

    // Vállalkozói szintű ár = tenant-specifikus ár a TenantPriceList-ben
    // Upsert: ha már van ilyen task-hoz ár, frissítjük; ha nincs, létrehozzuk

    // Csak azokat a mezőket adjuk meg, amelyeknek van értéke
    const updateData: any = {
      laborCost,
      materialCost,
    };

    if (unit) {
      updateData.unit = unit;
    }
    if (category) {
      updateData.category = category;
    }
    if (technology) {
      updateData.technology = technology;
    }

    const createData: any = {
      task: cleanedTask,
      tenantEmail,
      laborCost,
      materialCost,
    };

    if (unit) {
      createData.unit = unit;
    }
    if (category) {
      createData.category = category;
    }
    if (technology) {
      createData.technology = technology;
    }

    const result = await prisma.tenantPriceList.upsert({
      where: {
        tenant_task_unique: {
          task: cleanedTask,
          tenantEmail,
        },
      },
      update: updateData,
      create: createData,
    });

    console.log("saveTenantPrice sikeres:", result);

    return {
      success: true,
      message: "Vállalkozói szintű ár sikeresen mentve",
      data: result,
    };
  } catch (error) {
    console.error("Hiba a vállalkozói szintű ár mentésekor:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Ismeretlen hiba történt a vállalkozói szintű ár mentésekor",
    };
  }
}

/**
 * Globális ár mentése - amikor az offer-detail-mobile-ban módosítják az árakat
 * Globális szint = globális ár a PriceList-ben (tenantEmail: '')
 */
export async function saveGlobalPrice(
  task: string,
  category: string | null,
  technology: string | null,
  unit: string | null,
  laborCost: number,
  materialCost: number
) {
  try {
    // Tisztítsd meg a task nevet a * karaktertől
    const cleanedTask = task.replace(/^\*+\s*/, "").trim();

    console.log("saveGlobalPrice meghívva:", {
      originalTask: task,
      cleanedTask,
      category,
      technology,
      unit,
      laborCost,
      materialCost,
    });

    // Globális szintű ár = globális ár a PriceList-ben (tenantEmail: '')
    // Upsert: ha már van ilyen task-hoz ár, frissítjük; ha nincs, létrehozzuk

    // PriceList táblában a category, technology, unit kötelező mezők
    // Ha null-t kapunk, használjunk alapértelmezett értékeket
    const updateData: any = {
      laborCost,
      materialCost,
      unit: unit || "db",
      category: category || "Egyedi",
      technology: technology || "Egyedi",
    };

    const createData: any = {
      task: cleanedTask,
      tenantEmail: "", // Globális = üres string
      laborCost,
      materialCost,
      unit: unit || "db",
      category: category || "Egyedi",
      technology: technology || "Egyedi",
    };

    const result = await prisma.priceList.upsert({
      where: {
        task_tenantEmail: {
          task: cleanedTask,
          tenantEmail: "", // Globális = üres string
        },
      },
      update: updateData,
      create: createData,
    });

    console.log("saveGlobalPrice sikeres:", result);

    return {
      success: true,
      message: "Globális ár sikeresen mentve",
      data: result,
    };
  } catch (error) {
    console.error("Hiba a globális ár mentésekor:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Ismeretlen hiba történt a globális ár mentésekor",
    };
  }
}

export async function removeQuestionFromOffer(
  offerId: number,
  questionText: string
) {
  try {
    const { user, tenantEmail } = await getTenantSafeAuth();

    // Get the current offer
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      select: { description: true, tenantEmail: true },
    });

    if (!offer) {
      return { success: false, message: "Ajánlat nem található" };
    }

    // Check authorization
    if (offer.tenantEmail !== tenantEmail) {
      return {
        success: false,
        message: "Nincs jogosultsága ehhez az ajánlathoz",
      };
    }

    if (!offer.description) {
      return { success: false, message: "Nincs leírás az ajánlatban" };
    }

    // Remove the question from description
    const lines = offer.description.split(/\r?\n/);
    const updatedLines = lines.filter((line) => {
      const trimmed = line.trim();
      // Remove the line if it matches the question text
      if (trimmed.endsWith("?")) {
        // Extract question without numbering
        const match = trimmed.match(/^(\d+[.)]?\s*)(.*\?)$/);
        const questionOnly = match ? match[2].trim() : trimmed;
        return questionOnly !== questionText;
      }
      return true;
    });

    const updatedDescription = updatedLines.join("\n");

    // Update the offer
    await prisma.offer.update({
      where: { id: offerId },
      data: { description: updatedDescription },
    });

    revalidatePath("/offers");
    revalidatePath(`/offers/${offerId}`);

    return { success: true, description: updatedDescription };
  } catch (error) {
    console.error("Error removing question from offer:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Ismeretlen hiba történt a kérdés törlésekor",
    };
  }
}

export async function removeAllQuestionsFromOffer(offerId: number) {
  try {
    const { user, tenantEmail } = await getTenantSafeAuth();

    // Get the current offer
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      select: { description: true, tenantEmail: true },
    });

    if (!offer) {
      return { success: false, message: "Ajánlat nem található" };
    }

    // Check authorization
    if (offer.tenantEmail !== tenantEmail) {
      return {
        success: false,
        message: "Nincs jogosultsága ehhez az ajánlathoz",
      };
    }

    if (!offer.description) {
      return { success: false, message: "Nincs leírás az ajánlatban" };
    }

    // Remove all questions from description
    const lines = offer.description.split(/\r?\n/);
    const updatedLines = lines.filter((line) => {
      const trimmed = line.trim();
      // Remove all lines ending with "?"
      return !trimmed.endsWith("?");
    });

    const updatedDescription = updatedLines.join("\n");

    // Update the offer
    await prisma.offer.update({
      where: { id: offerId },
      data: { description: updatedDescription },
    });

    revalidatePath("/offers");
    revalidatePath(`/offers/${offerId}`);

    return { success: true, description: updatedDescription };
  } catch (error) {
    console.error("Error removing all questions from offer:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Ismeretlen hiba történt a kérdések törlésekor",
    };
  }
}

/**
 * Aktív munkák lekérése (meglévő munkához rendeléshez)
 */
export async function getActiveWorks() {
  try {
    const { tenantEmail } = await getTenantSafeAuth();

    const works = await prisma.work.findMany({
      where: {
        tenantEmail: tenantEmail,
        isActive: true,
      },
      select: {
        id: true,
        title: true,
        status: true,
        location: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return { success: true, works };
  } catch (error) {
    console.error("Hiba a munkák lekérésekor:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Ismeretlen hiba történt a munkák lekérésekor",
      works: [],
    };
  }
}

/**
 * Offer hozzárendelése egy meglévő munkához
 * Az offer status-t "work"-re állítja és hozzáadja a linkedOfferIds-hoz
 */
export async function assignOfferToExistingWork(
  offerId: number,
  workId: number
) {
  try {
    const { user, tenantEmail } = await getTenantSafeAuth();

    // 1. Lekérjük az offer-t
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
    });

    if (!offer) {
      return { success: false, message: "Az ajánlat nem található!" };
    }

    // 2. Lekérjük a work-öt
    const work = await prisma.work.findUnique({
      where: { id: workId },
    });

    if (!work) {
      return { success: false, message: "A munka nem található!" };
    }

    // 3. Ellenőrizzük, hogy az offer már hozzá van-e rendelve
    if (work.linkedOfferIds.includes(offerId)) {
      return {
        success: false,
        message: "Ez az ajánlat már hozzá van rendelve ehhez a munkához!",
      };
    }

    // 4. Tranzakció: frissítjük a Work-öt és az Offer-t
    await prisma.$transaction(async (tx) => {
      // 4.1. Offer status frissítése "work"-re
      await tx.offer.update({
        where: { id: offerId },
        data: {
          status: "work",
          updatedAt: new Date(),
        },
      });

      // 4.2. Work frissítése - linkedOfferIds hozzáadása
      const newLinkedOfferIds = [...work.linkedOfferIds, offerId];

      await tx.work.update({
        where: { id: workId },
        data: {
          linkedOfferIds: newLinkedOfferIds,
          updatedAt: new Date(),
        },
      });
    });

    // 5. Cache frissítése
    revalidatePath(`/dashboard/offers/${offerId}`);
    revalidatePath("/dashboard/offers");
    revalidatePath("/works");
    revalidatePath(`/works/${workId}`);

    return {
      success: true,
      message: "Az ajánlat sikeresen hozzárendelve a munkához!",
      workId: workId,
    };
  } catch (error) {
    console.error("Hiba az offer munkához rendelésekor:", error);
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Ismeretlen hiba történt az offer munkához rendelésekor",
    };
  }
}
