"use client";

import React, { useState, useEffect } from "react";
import { httpsCallable } from "firebase/functions";
import { doc, setDoc } from "firebase/firestore";
import { firebaseAuth, firestoreDb, firebaseFunctions } from "../lib/firebaseClient";
import type { MetaAdAccount, MetaPage } from "../../types";

interface FacebookLoginResponse {
  authResponse?: {
    accessToken?: string;
  };
}

interface FacebookSdk {
  init: (config: { appId?: string; cookie: boolean; xfbml: boolean; version: string }) => void;
  login: (
    callback: (response: FacebookLoginResponse) => void,
    options: { scope: string }
  ) => void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

interface ConnectMetaResult {
  success: boolean;
  adAccounts: MetaAdAccount[];
  pages: MetaPage[];
}

export default function MetaConnectButton({ onConnected }: { onConnected?: () => void }) {
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [adAccounts, setAdAccounts] = useState<MetaAdAccount[]>([]);
  const [pages, setPages] = useState<MetaPage[]>([]);
  const [selectedAdAccount, setSelectedAdAccount] = useState("");
  const [selectedPage, setSelectedPage] = useState("");

  useEffect(() => {
    if (document.getElementById("facebook-jssdk")) {
      setSdkLoaded(true);
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: process.env.NEXT_PUBLIC_META_APP_ID,
        cookie: true,
        xfbml: false,
        version: "v21.0",
      });
      setSdkLoaded(true);
    };

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
  }, []);

  const handleFacebookLogin = () => {
    if (!window.FB) return;
    setIsLoading(true);

    window.FB.login(
      (response) => {
        const shortLivedToken = response.authResponse?.accessToken;
        if (!shortLivedToken) {
          setIsLoading(false);
          return;
        }

        const connectMetaAccount = httpsCallable<{ shortLivedToken: string }, ConnectMetaResult>(
          firebaseFunctions,
          "connectMetaAccount"
        );

        connectMetaAccount({ shortLivedToken })
          .then((res) => {
            setAdAccounts(res.data.adAccounts || []);
            setPages(res.data.pages || []);
          })
          .catch((err: Error) => {
            alert(`Meta連携エラー: ${err.message}`);
          })
          .finally(() => {
            setIsLoading(false);
          });
      },
      { scope: "ads_management,ads_read,pages_show_list,pages_read_engagement,business_management" }
    );
  };

  const handleSaveSelection = async () => {
    const user = firebaseAuth.currentUser;
    if (!user || !selectedAdAccount || !selectedPage) return;

    setIsLoading(true);
    try {
      await setDoc(
        doc(firestoreDb, "users", user.uid),
        {
          metaConnection: {
            selectedAdAccountId: selectedAdAccount,
            selectedFacebookPageId: selectedPage,
          },
        },
        { merge: true }
      );
      alert("Meta広告アカウントの連携が完了しました！");
      if (onConnected) onConnected();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "不明なエラー";
      alert(`保存エラー: ${message}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-gray-900 text-sm">Meta広告アカウント連携</h2>
          <p className="text-xs text-gray-500">
            Facebookビジネスアカウントを接続して自動入稿・監視を有効にします
          </p>
        </div>
        <button
          type="button"
          onClick={handleFacebookLogin}
          disabled={!sdkLoaded || isLoading}
          className="px-4 py-2 bg-[#1877F2] text-white text-xs font-bold rounded-lg hover:bg-[#166FE5] disabled:opacity-50"
        >
          {isLoading ? "接続中..." : "Facebookでログインして連携"}
        </button>
      </div>

      {adAccounts.length > 0 && (
        <div className="pt-4 border-t border-gray-200 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div>
            <label htmlFor="ad-account-select" className="block text-xs font-medium text-gray-600 mb-1">
              使用する広告アカウント
            </label>
            <select
              id="ad-account-select"
              name="selectedAdAccount"
              value={selectedAdAccount}
              onChange={(e) => setSelectedAdAccount(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs bg-white"
            >
              <option value="">選択してください</option>
              {adAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="fb-page-select" className="block text-xs font-medium text-gray-600 mb-1">
              出稿元 Facebookページ
            </label>
            <select
              id="fb-page-select"
              name="selectedPage"
              value={selectedPage}
              onChange={(e) => setSelectedPage(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs bg-white"
            >
              <option value="">選択してください</option>
              {pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.name} ({page.id})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={handleSaveSelection}
            disabled={!selectedAdAccount || !selectedPage || isLoading}
            className="px-4 py-2 bg-gray-900 text-white text-xs font-semibold rounded-lg hover:bg-gray-800 disabled:opacity-50"
          >
            このアカウントを確定
          </button>
        </div>
      )}
    </section>
  );
}
