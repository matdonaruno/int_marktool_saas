"use client";

import React, { useState, useEffect } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  User,
} from "firebase/auth";
import { doc, getDoc, setDoc, collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import MetaConnectButton from "../components/MetaConnectButton";
import { firebaseAuth, firestoreDb, firebaseFunctions } from "../lib/firebaseClient";
import type {
  BrandDnaDocument,
  CreativeDocument,
  GenerateCreativeRequest,
  GenerateCreativeResponse,
  GuardrailConfig,
  PublishMetaAdRequest,
  PublishMetaAdResponse,
} from "../../types";

interface UserDocData {
  guardrails?: Partial<GuardrailConfig>;
  metaConnection?: {
    selectedFacebookPageId?: string;
  };
}

export default function AdAutopilotDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  // Auth form state
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [isSignUpMode, setIsSignUpMode] = useState(false);

  // Guardrails state
  const [isAutopilot, setIsAutopilot] = useState(false);
  const [isOrganicAutoPost, setIsOrganicAutoPost] = useState(false);
  const [dailySpendCap, setDailySpendCap] = useState(10000);
  const [targetCpa, setTargetCpa] = useState(3000);
  const [minRoas, setMinRoas] = useState(2.0);

  // Creative form state
  const [productName, setProductName] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [landingPageUrl, setLandingPageUrl] = useState("");
  const [facebookPageId, setFacebookPageId] = useState("");
  const [winningCompetitorAd, setWinningCompetitorAd] = useState("");
  const [creatives, setCreatives] = useState<CreativeDocument[]>([]);

  useEffect(() => {
    let unsubscribeCreatives: (() => void) | undefined;

    const unsubscribeAuth = onAuthStateChanged(firebaseAuth, async (currentUser) => {
      setUser(currentUser);
      if (unsubscribeCreatives) {
        unsubscribeCreatives();
        unsubscribeCreatives = undefined;
      }
      if (!currentUser) {
        setCreatives([]);
        return;
      }

      const userDoc = await getDoc(doc(firestoreDb, "users", currentUser.uid));
      if (userDoc.exists()) {
        const data = userDoc.data() as UserDocData;
        if (data.guardrails) {
          setIsAutopilot(data.guardrails.isAutopilotEnabled ?? false);
          setIsOrganicAutoPost(data.guardrails.isOrganicAutoPostEnabled ?? false);
          setDailySpendCap(data.guardrails.dailySpendCap ?? 10000);
          setTargetCpa(data.guardrails.targetCpa ?? 3000);
          setMinRoas(data.guardrails.minRoas ?? 2.0);
        }
        if (data.metaConnection?.selectedFacebookPageId) {
          setFacebookPageId(data.metaConnection.selectedFacebookPageId);
        }
      }

      const q = query(
        collection(firestoreDb, "users", currentUser.uid, "creatives"),
        orderBy("createdAt", "desc")
      );
      unsubscribeCreatives = onSnapshot(q, (snapshot) => {
        setCreatives(
          snapshot.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<CreativeDocument, "id">),
          }))
        );
      });
    });

    return () => {
      if (unsubscribeCreatives) unsubscribeCreatives();
      unsubscribeAuth();
    };
  }, []);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setStatusMessage("");
    try {
      if (isSignUpMode) {
        await createUserWithEmailAndPassword(firebaseAuth, authEmail, authPassword);
      } else {
        await signInWithEmailAndPassword(firebaseAuth, authEmail, authPassword);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "認証エラー";
      setStatusMessage(`認証エラー: ${message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveGuardrails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setIsLoading(true);
    try {
      await setDoc(
        doc(firestoreDb, "users", user.uid),
        {
          guardrails: {
            isAutopilotEnabled: isAutopilot,
            isOrganicAutoPostEnabled: isOrganicAutoPost,
            dailySpendCap: Number(dailySpendCap),
            targetCpa: Number(targetCpa),
            minRoas: Number(minRoas),
            evaluationWindowHours: 48,
          },
        },
        { merge: true }
      );
      setStatusMessage("安全ガードレール設定を保存しました。");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "不明なエラー";
      setStatusMessage(`保存エラー: ${message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExtractFromUrl = async () => {
    if (!landingPageUrl) {
      alert("先に販売ページURL（LP）を入力してください。");
      return;
    }
    setIsLoading(true);
    setStatusMessage("LPを解析してブランドDNA・ターゲットの悩みを自動抽出中...");
    try {
      const extractBrandDna = httpsCallable<{ productUrl: string }, BrandDnaDocument>(
        firebaseFunctions,
        "extractBrandDna"
      );
      const res = await extractBrandDna({ productUrl: landingPageUrl });
      setProductName(res.data.brandName || "");
      setProductDescription(
        `【強み】${(res.data.uniqueSellingPoints || []).join(" / ")}\n【ターゲットの悩み】${(res.data.corePainPoints || []).join(" / ")}`
      );
      setStatusMessage("LPからのブランドDNA抽出が完了しました！");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "不明なエラー";
      setStatusMessage(`URL解析エラー: ${message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateCreative = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setIsLoading(true);
    setStatusMessage("Step 1/3: Geminiが広告コピーを生成＆Criticが品質審査中...");
    try {
      const generateVerifiedCreative = httpsCallable<
        GenerateCreativeRequest,
        GenerateCreativeResponse
      >(firebaseFunctions, "generateVerifiedCreative");
      const textRes = await generateVerifiedCreative({
        campaignId: "default_campaign",
        productName,
        productDescription,
        winningCompetitorAd,
      });

      const creativeId = textRes.data.creativeId;
      setStatusMessage(
        `Step 2/3: 審査合格（${textRes.data.criticScore}点）！Imagen 3でベース画像を生成中...`
      );
      const generateCreativeImage = httpsCallable<{ creativeId: string; aspectRatio: string }, unknown>(
        firebaseFunctions,
        "generateCreativeImage"
      );
      await generateCreativeImage({ creativeId, aspectRatio: "1:1" });

      setStatusMessage("Step 3/3: キャッチコピー＆ブランドカラー帯を画像に鮮明合成中...");
      const compositeAdOverlay = httpsCallable<{ creativeId: string; brandColor: string }, unknown>(
        firebaseFunctions,
        "compositeAdOverlay"
      );
      await compositeAdOverlay({ creativeId, brandColor: "#1E3A8A" });

      setStatusMessage("クリエイティブの生成・品質審査・文字合成がすべて完了しました！");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "不明なエラー";
      setStatusMessage(`生成エラー: ${message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePublishToMeta = async (creativeId: string) => {
    if (!landingPageUrl || !facebookPageId) {
      alert("LP URLとFacebookページIDが必要です。");
      return;
    }
    setIsLoading(true);
    setStatusMessage("Meta Marketing APIへキャンペーン・広告セット・クリエイティブを入稿中...");
    try {
      const publishCreativeToMeta = httpsCallable<PublishMetaAdRequest, PublishMetaAdResponse>(
        firebaseFunctions,
        "publishCreativeToMeta"
      );
      const res = await publishCreativeToMeta({
        creativeId,
        dailyBudget: 3000,
        targetCountry: "JP",
        landingPageUrl,
        facebookPageId,
      });
      setStatusMessage(
        `Meta広告への入稿が完了しました！（Campaign ID: ${res.data.metaCampaignId} / ステータス: ${res.data.status}）`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "不明なエラー";
      setStatusMessage(`入稿エラー: ${message}`);
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md bg-white p-8 rounded-xl border border-gray-200 shadow-sm space-y-6">
          <h1 id="auth-heading" className="text-xl font-bold text-gray-900 text-center">
            AI Ad Autopilot SaaS {isSignUpMode ? "新規登録" : "ログイン"}
          </h1>
          {statusMessage && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
              {statusMessage}
            </div>
          )}
          <form onSubmit={handleAuthSubmit} aria-labelledby="auth-heading" className="space-y-4">
            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-gray-700 mb-1">
                メールアドレス
              </label>
              <input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="auth-password" className="block text-xs font-medium text-gray-700 mb-1">
                パスワード
              </label>
              <input
                id="auth-password"
                name="password"
                type="password"
                autoComplete={isSignUpMode ? "new-password" : "current-password"}
                required
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 bg-blue-600 text-white font-medium text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {isLoading ? "処理中..." : isSignUpMode ? "アカウント作成" : "ログイン"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setIsSignUpMode((prev) => !prev)}
            className="w-full text-xs text-blue-600 hover:underline"
          >
            {isSignUpMode ? "すでにアカウントをお持ちの方はこちら" : "新規アカウントを作成する"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-8 bg-gray-50 min-h-screen">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-200 pb-4">
        <h1 className="text-2xl font-bold text-gray-900">AI Ad Autopilot ダッシュボード</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">ログイン中: {user.email}</span>
          <button
            type="button"
            onClick={() => signOut(firebaseAuth)}
            className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-100"
          >
            ログアウト
          </button>
        </div>
      </header>

      {statusMessage && (
        <div role="status" className="p-4 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-sm font-medium">
          {statusMessage}
        </div>
      )}

      <MetaConnectButton />

      <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4">
        <h2 id="guardrails-heading" className="text-lg font-semibold text-gray-800">
          1. 自動運用ガードレール（暴走防止設定）
        </h2>
        <form onSubmit={handleSaveGuardrails} aria-labelledby="guardrails-heading" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="daily-spend-cap" className="block text-xs font-medium text-gray-600 mb-1">
                1日の最大予算上限（円）
              </label>
              <input
                id="daily-spend-cap"
                name="dailySpendCap"
                type="number"
                value={dailySpendCap}
                onChange={(e) => setDailySpendCap(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="target-cpa" className="block text-xs font-medium text-gray-600 mb-1">
                目標CPA上限（円）
              </label>
              <input
                id="target-cpa"
                name="targetCpa"
                type="number"
                value={targetCpa}
                onChange={(e) => setTargetCpa(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="min-roas" className="block text-xs font-medium text-gray-600 mb-1">
                最低ROAS基準（倍）
              </label>
              <input
                id="min-roas"
                name="minRoas"
                type="number"
                step="0.1"
                value={minRoas}
                onChange={(e) => setMinRoas(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <fieldset className="flex flex-wrap gap-6 pt-2">
            <legend className="sr-only">自動運用オプション</legend>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                name="isAutopilot"
                checked={isAutopilot}
                onChange={(e) => setIsAutopilot(e.target.checked)}
                className="h-4 w-4 text-blue-600"
              />
              Autopilot（即配信＆8時間監視）を有効化
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                name="isOrganicAutoPost"
                checked={isOrganicAutoPost}
                onChange={(e) => setIsOrganicAutoPost(e.target.checked)}
                className="h-4 w-4 text-blue-600"
              />
              毎日SNSオーガニック投稿を有効化
            </label>
          </fieldset>

          <button
            type="submit"
            disabled={isLoading}
            className="px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800 disabled:opacity-50"
          >
            ガードレール設定を保存
          </button>
        </form>
      </section>

      <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4">
        <h2 id="creative-gen-heading" className="text-lg font-semibold text-gray-800">
          2. AIクリエイティブ自動生成（URL解析 → Critic検品 → 文字合成）
        </h2>
        <form onSubmit={handleGenerateCreative} aria-labelledby="creative-gen-heading" className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <label htmlFor="lp-url" className="sr-only">
              販売ページURL
            </label>
            <input
              id="lp-url"
              name="landingPageUrl"
              type="url"
              placeholder="販売ページURL（LP）を入力して自動解析..."
              value={landingPageUrl}
              onChange={(e) => setLandingPageUrl(e.target.value)}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={handleExtractFromUrl}
              disabled={isLoading}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50"
            >
              URLからブランドDNA自動抽出
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="product-name" className="block text-xs font-medium text-gray-600 mb-1">
                商品名・サービス名（必須）
              </label>
              <input
                id="product-name"
                name="productName"
                type="text"
                required
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="facebook-page-id" className="block text-xs font-medium text-gray-600 mb-1">
                出稿元 FacebookページID
              </label>
              <input
                id="facebook-page-id"
                name="facebookPageId"
                type="text"
                value={facebookPageId}
                onChange={(e) => setFacebookPageId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="product-desc" className="block text-xs font-medium text-gray-600 mb-1">
              商品の特徴・強み・ターゲット層の詳細（必須）
            </label>
            <textarea
              id="product-desc"
              name="productDescription"
              required
              rows={3}
              value={productDescription}
              onChange={(e) => setProductDescription(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="competitor-ad" className="block text-xs font-medium text-gray-600 mb-1">
              参考にする競合の勝ち広告コピー（任意）
            </label>
            <textarea
              id="competitor-ad"
              name="winningCompetitorAd"
              rows={2}
              value={winningCompetitorAd}
              onChange={(e) => setWinningCompetitorAd(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="px-6 py-2.5 bg-blue-600 text-white font-medium text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? "AIが生成・検品・合成中..." : "AIクリエイティブを生成＆自動審査する"}
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">3. クリエイティブ一覧＆パフォーマンス</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {creatives.map((item) => (
            <article
              key={item.id}
              className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col justify-between"
            >
              <div>
                {item.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.mediaUrl}
                    alt={item.headline || "生成広告クリエイティブ"}
                    className="w-full h-56 object-cover bg-gray-100"
                  />
                ) : (
                  <div className="w-full h-56 bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                    画像未生成
                  </div>
                )}

                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-blue-700">Criticスコア: {item.criticScore}点</span>
                    <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-medium">
                      {item.status}
                    </span>
                  </div>
                  <h3 className="font-bold text-gray-900 text-sm">{item.headline}</h3>
                  <p className="text-xs text-gray-600 whitespace-pre-line line-clamp-4">{item.primaryText}</p>
                </div>
              </div>

              <div className="p-4 pt-0 space-y-3">
                {item.metrics && item.metrics.impressions > 0 && (
                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-gray-100 text-center text-xs">
                    <div>
                      <div className="text-gray-400">消化額</div>
                      <div className="font-semibold">¥{item.metrics.spend.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-gray-400">CPA</div>
                      <div className="font-semibold">¥{Math.round(item.metrics.cpa).toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-gray-400">ROAS</div>
                      <div className="font-semibold">{item.metrics.roas.toFixed(2)}x</div>
                    </div>
                  </div>
                )}

                {!item.metaAdId && item.mediaUrl && item.id && (
                  <button
                    type="button"
                    onClick={() => handlePublishToMeta(item.id!)}
                    disabled={isLoading}
                    className="w-full py-2 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Meta広告へ入稿する
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
