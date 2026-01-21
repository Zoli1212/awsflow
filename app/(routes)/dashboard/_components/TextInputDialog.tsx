"use client";

import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Sparkles, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useDemandStore } from "@/store/offerLetterStore";
import { useOfferItemQuestionStore } from "@/store/offerItemQuestionStore";
import { useOfferItemCheckStore } from "@/store/offerItemCheckStore";

interface TextInputDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export default function TextInputDialog({
  open,
  setOpen,
}: TextInputDialogProps) {
  const { demandText, setDemandText } = useDemandStore();
  // Lokális state a textarea-hoz - nem rendereli újra a store-t minden karakternél
  const [localText, setLocalText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadingFile, setUploadingFile] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const router = useRouter();

  const { clearOfferItemsQuestion } = useOfferItemQuestionStore();
  const { clearOfferItems } = useOfferItemCheckStore();
  const { clearExtraRequirementText } = useDemandStore();

  // Dialog megnyitásakor szinkronizáljuk a lokális state-et a store-ból
  useEffect(() => {
    if (open) {
      setLocalText(demandText);
    }
  }, [open, demandText]);

  useEffect(() => {
    clearOfferItemsQuestion();
    clearOfferItems();
    clearExtraRequirementText();
  }, [clearOfferItemsQuestion, clearOfferItems, clearExtraRequirementText]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const fileName = file.name.toLowerCase();
      if (
        fileName.endsWith(".xlsx") ||
        fileName.endsWith(".xls") ||
        fileName.endsWith(".pdf")
      ) {
        setSelectedFile(file);
        setError("");
      } else {
        setError("Csak Excel (.xlsx, .xls) és PDF fájlokat fogadunk el.");
      }
    }
  };

  const handleFileUpload = async () => {
    if (!selectedFile) return;

    setUploadingFile(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await axios.post("/api/parse-file", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });

      if (response.data.success) {
        setLocalText(response.data.extractedText);
        setSelectedFile(null);
      } else {
        setError(
          response.data.error || "Hiba történt a fájl feldolgozása során."
        );
      }
    } catch (err: unknown) {
      console.error("File upload error:", err);
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(
        axiosError.response?.data?.error ||
          "Hiba történt a fájl feldolgozása során. Kérjük próbáld újra."
      );
    } finally {
      setUploadingFile(false);
    }
  };

  const clearFile = () => {
    setSelectedFile(null);
    setError("");
  };

  const onAnalyze = async () => {
    if (!localText.trim()) {
      setError("Kérjük adj meg egy szöveget az elemzéshez!");
      return;
    }

    setLoading(true);
    setError("");

    // Szinkronizáljuk a store-ba submit előtt
    setDemandText(localText);

    try {
      // Új OpenAI endpoint használata (nincs Inngest, History)
      const result = await axios.post("/api/openai-offer", {
        userInput: localText,
        existingItems: [],
      });

      const { success, workId, requirementId, offerId } = result.data;

      if (success) {
        console.log("Offer created:", { workId, requirementId, offerId });

        // Átirányítás az offer részletekhez
        setLoading(false);
        router.push(`/offers/${requirementId}?offerId=${offerId}`);
        setOpen(false);
      } else {
        throw new Error("Offer creation failed");
      }
    } catch (err) {
      console.error("Error processing text:", err);
      setError("Hiba történt a feldolgozás során. Kérjük próbáld újra később.");
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[600px] h-[90vh] max-h-[800px] flex flex-col">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <Loader2 className="w-16 h-16 text-blue-500 animate-spin mb-6" />
            <h3 className="text-xl font-semibold text-gray-800 mb-2">
              Feldolgozás folyamatban
            </h3>
            <p className="text-gray-600 max-w-md">
              Az Ön kérése feldolgozás alatt áll, kérjük várjon...
            </p>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <DialogHeader className="px-1">
              <DialogTitle className="text-xl font-bold text-gray-900">
                Új ajánlatkérés
              </DialogTitle>
              <DialogDescription className="text-gray-600">
                Illessze be az ajánlatkérést vagy írja le részletesen mire van
                szüksége
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 mt-4 overflow-hidden">
              <div className="h-full flex flex-col">
                {/* Fájl feltöltés gomb */}
                <div className="mb-4">
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      id="file-upload"
                      className="hidden"
                      accept=".xlsx,.xls,.pdf"
                      onChange={handleFileSelect}
                      disabled={uploadingFile || loading}
                    />
                    <label
                      htmlFor="file-upload"
                      className="flex-1 cursor-pointer"
                    >
                      <div className="flex items-center gap-2 px-4 py-3 bg-white border border-[#FF9900] rounded-lg hover:bg-orange-50 transition-colors">
                        <Upload className="w-5 h-5 text-[#FF9900]" />
                        <span className="text-sm font-medium text-gray-700">
                          {selectedFile
                            ? selectedFile.name
                            : "Beérkezett ajánlatkérés feltöltése (Excel/PDF)"}
                        </span>
                      </div>
                    </label>
                    {selectedFile && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleFileUpload}
                          disabled={uploadingFile}
                          className="bg-[#FF9900] hover:bg-[#e68a00] text-white"
                        >
                          {uploadingFile ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin mr-1" />
                              Feldolgozás...
                            </>
                          ) : (
                            "Feldolgozás"
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={clearFile}
                          disabled={uploadingFile}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <Textarea
                  placeholder="Például: 50m²-es lakás felújítása, burkolással, festéssel és villanyszereléssel..."
                  className="flex-1 min-h-[200px] text-base p-4 resize-none"
                  value={localText}
                  onChange={(e) => {
                    setLocalText(e.target.value);
                    setError("");
                  }}
                />
                {error && (
                  <div className="mt-2 px-4 py-2 bg-red-50 text-red-600 text-sm rounded-md">
                    {error}
                  </div>
                )}

                <div className="mt-4 pt-4 border-t border-gray-100">
                  <div className="text-sm text-gray-500 mb-3">Tippek:</div>
                  <ul className="space-y-2 text-sm text-gray-600">
                    <li className="flex items-start">
                      <span className="text-blue-500 mr-2">•</span>
                      <span>Minden fontos információt írjon le</span>
                    </li>
                    <li className="flex items-start">
                      <span className="text-blue-500 mr-2">•</span>
                      <span>Adja meg a pontos helyszínt</span>
                    </li>
                    <li className="flex items-start">
                      <span className="text-blue-500 mr-2">•</span>
                      <span>Mikorra lenne szüksége a munkákra?</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <DialogFooter className="flex flex-col sm:flex-row gap-3 pt-4 mt-auto">
              <Button
                variant="outline"
                className="w-full h-14 text-base font-medium"
                onClick={() => setOpen(false)}
              >
                Mégse
              </Button>
              <Button
                className="w-full h-14 text-base font-medium bg-[#FF9900] hover:bg-[#e68a00] text-white"
                disabled={!localText.trim() || loading}
                onClick={onAnalyze}
                size="lg"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Folyamatban...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-5 w-5" />
                    Elemzés indítása
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
