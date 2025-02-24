'use strict';

import client from 'cheerio-httpcli';
import { parseString } from 'xml2js';
import gplay from 'google-play-scraper'

import AppData from './AppData';
import Notification from './Notification';
import ReviewData from './ReviewData';
import { formatDate } from './util';

/**
 * レビューの取得・解析処理を行う
 */
export default class Review {

  constructor(outputs, ignoreNotification, config, db) {
    this.outputs = outputs;
    this.ignoreNotification = ignoreNotification;
    this.config = config;
    this.db = db;

    // 下位互換性
    if (this.config.appId) {
      // 国別コードの指定はjaをメインに、jpをサブにする。
      this.lang = this.config.acceptLanguage;
      this.lang_sub = this.lang;
      if (this.lang === "ja") {
        this.lang_sub = "jp"
      } else if (this.lang === "jp") {
        this.lang = "ja"
      }
    }

    // 情報取得元のURLを生成
    this.ios_base_url = "http://itunes.apple.com/" + this.lang_sub + "/rss/customerreviews";
    // 初回通知しないオプション（起動後に設定されたレビュー結果を通知しないためのオプション）
    this.ignoreNotification = ignoreNotification;

    this.main = this.main.bind(this);
    this.ios = this.ios.bind(this);
    this.android = this.android.bind(this);
    this.noticeAppReview = this.noticeAppReview.bind(this);
    this.createIosUrl = this.createIosUrl.bind(this);
    this.createAndroidUrl = this.createAndroidUrl.bind(this);
    this.analyzeIosData = this.analyzeIosData.bind(this);
    this.getIosReview = this.getIosReview.bind(this);
    this.analyzeAndroidData = this.analyzeAndroidData.bind(this);
    this.getAndroidReview = this.getAndroidReview.bind(this);
    this.insertReviewData = this.insertReviewData.bind(this);
    this.pushData = this.pushData.bind(this);
    this.selectRecord = this.selectRecord.bind(this);
  }

  /**
   * reviewetのメイン処理
   *
   * 指定されたiOS/AndroidのアプリIDに対して、レビューの取得処理を実施する。
   * 設定されていないOSについては何もしない。
   */
  main() {
    if (this.config.appId) {
      // 下位互換性
      let iosIds = this.config.appId.iOS;
      if (iosIds) {
        if (!Array.isArray(iosIds)) {
          iosIds = [iosIds];
        }
        this.ios(iosIds.map(e => {
          return {
            id: e,
            countryCode: [this.lang_sub],
          }
        }));
      }
    } else {
      let iosApps = this.config.app.iOS;
      if (iosApps) {
        if (!Array.isArray(iosApps)) {
          iosApps = [iosApps];
        }
        iosApps = iosApps.map(e => {
          if (!Array.isArray(e.countryCode)) {
            e.countryCode = [e.countryCode]
          }
          return e
        })
        this.ios(iosApps);
      }
    }

    if (this.config.appId) {
      // 下位互換性
      let androidIds = this.config.appId.android;
      if (androidIds) {
        if (!Array.isArray(androidIds)) {
          androidIds = [androidIds];
        }
        this.android(androidIds.map(e => {
          return {
            id: e,
            languageCode: [this.lang],
          }
        }));
      }
    } else {
      let androidApps = this.config.app.android;
      if (androidApps) {
        if (!Array.isArray(androidApps)) {
          androidApps = [androidApps];
        }
        androidApps = androidApps.map(e => {
          if (!Array.isArray(e.languageCode)) {
            e.languageCode = [e.languageCode]
          }
          return e
        })
        this.android(androidApps);
      }
    }
  }

  /**
   * iOSのストアレビューを通知する
   *
   * @param {array<Object>} iosApps アプリリスト
   * @param {string} iosApp.id アプリID
   * @param {array<string>} iosApp.countryCode 国コード
   */
  ios(iosApps) {
    if (iosApps !== null) {
      for (let i = 0; i < iosApps.length; i++) {
        let iosId = iosApps[i].id;
        let name = iosApps[i].name;
        let iosCountryCodes = iosApps[i].countryCode;
        for (let j = 0; j < iosCountryCodes.length; j++) {
          let iosCountryCode = iosCountryCodes[j];
          let ios_url = this.createIosUrl(iosId, iosCountryCode);
          let iosApp = new AppData("iOS", iosId, iosCountryCode);
          iosApp.name = name

          // iOSアプリのレビューを通知
          this.noticeAppReview(iosApp, ios_url, this.analyzeIosData);
        }
      }
    }
  }

  /**
   * Androidのストアレビューを通知する
   *
   * @param {array<object>} androidApps アプリリスト
   * @param {string} androidApp.id アプリID
   * @param {array<string>} androidApp.languageCode 言語コード
   */
  android(androidApps) {
    if (androidApps !== null) {
      for (let i = 0; i < androidApps.length; i++) {
        let androidId = androidApps[i].id;
        let name = androidApps[i].name;
        let androidLanguageCodes = androidApps[i].languageCode;
        for (let j = 0; j < androidLanguageCodes.length; j++) {
          let androidLanguageCode = androidLanguageCodes[j];
          let android_url = this.createAndroidUrl(androidId, androidLanguageCode);
          let androidApp = new AppData("Android", androidId, androidLanguageCode);
          androidApp.name = name

          // Androidはストアサイトから直接データを取得するので、遷移先のURLにそのまま使う
          androidApp.url = android_url;

          // Androidアプリのレビューを通知
          this.noticeAppReview(androidApp, android_url, this.analyzeAndroidData);
        }
      }
    }
  }

  /**
   * 対象OSのアプリレビューを取得して通知する
   *
   * @param appData
   * @param url
   * @param appfunc OS別のレビュー取得処理
   */
  noticeAppReview(appData, url, appfunc) {
    let outputs = this.outputs;
    const config = this.config;
    const useSlack = config.slack.use;
    const useEmail = config.email.use;

    // アプリのレビューデータを取得
    let param = {};
    client.fetch(url, param, (err, $, res) => {
      if (err) {
        console.log(formatDate(new Date(), "YYYY/MM/DD hh:mm:ss") + " Error:", err);
        return;
      }

      appfunc($, appData).then((reviewData) => {

        const notification = new Notification(appData, reviewData, config);
        // 表示件数制御
        if (outputs >= 0 && reviewData !== null && reviewData.length > outputs) {
          reviewData.length = outputs;
        }
        if (useSlack) {
          notification.slack();
        }

        if (useEmail) {
          notification.email();
        }
      });
    });
  }

  /**
   * iOSアプリのレビューデータ取得元のURLを生成する。
   * @param {string} appId 取得対象アプリのAppStore ID
   * @param {string} countryCode 取得対象アプリのAppStore国コード
   * @param {number} page ページインデックス
   */
  createIosUrl(appId, countryCode, page) {
    let url = "http://itunes.apple.com/" + countryCode + "/rss/customerreviews";
    if (page !== null && page > 0) {
      url += "/page=" + page + "/id=" + appId + "/sortBy=mostRecent/xml";
    } else {
      url += "/id=" + appId + "/sortBy=mostRecent/xml";
    }

    return url;
  }

  /**
   * Androidアプリのレビューデータ取得元のURLを生成する。
   * @param {string} appId 取得対象アプリのGooglePlay ID
   * @param {string} languageCode 取得対象アプリのGooglePlay言語コード
   */
  createAndroidUrl(appId, languageCode) {
    return "https://play.google.com/store/apps/details?id=" + appId + "&hl=" + languageCode;
  }

  /**
   * iOSのレビュー情報を解析して、整形したレビューデータを返却する。
   */
  analyzeIosData($, appData) {

    return new Promise((resolve, reject) => {
      // RSSの内容を解析してレビューデータを作成
      const reviewDataXml = $.xml();
      let reviewDatas = [];
      parseString(reviewDataXml, (err, result) => {

        // アプリレビューがない場合は終了
        if (!result.feed.entry) {
          resolve(reviewDatas);
          return
        }

        // アプリ情報を設定
        appData.url = result.feed.entry[0].link[0].$.href;

        // レビュー情報を設定
        let reviewProcess = [];
        for (let i = 1; i < result.feed.entry.length; i++) {
          const entry = result.feed.entry[i];
          reviewProcess.push(this.getIosReview(appData, entry));
        }
        Promise.all(reviewProcess).then((datas) => {
          let returnData = [];
          for (let i = 0; i < datas.length; i++) {
            if (datas[i] !== null) {
              returnData.push(datas[i]);
            }
          }
          resolve(returnData);
        });
      });
    });
  }

  /**
   * iOSのレビュー情報の解析処理。
   * 取得したレビュー情報が新規であればDBに保存し、通知用データとして返却する。
   */
  getIosReview(appData, entry) {

    return new Promise((resolve, reject) => {
      let param = [];

      // Android側の制御にあわせて日付を文字列で保持する
      param.updated = formatDate(new Date(entry.updated[0]), "YYYY/MM/DD hh:mm:ss");
      param.reviewId = entry.id[0];
      param.kind = appData.kind
      param.name = appData.name
      param.title = entry.title[0];
      param.message = entry.content[0]._;
      param.rating = entry['im:rating'];
      param.version = entry['im:version'] + ''; // 文字列に変換

      let reviewData = new ReviewData(param);

      // DBに登録を試みて、登録できれば新規レビューなので通知用レビューデータとして返却する
      this.insertReviewData(appData, reviewData).then((result) => {
        this.pushData(result, reviewData).then((data) => {
          resolve(data)
        });
      });
    });
  }


  /**
   * Androindのレビュー情報を解析して、整形したレビューデータを返却する。
   * ※Androidは$をそのまま使って処理してみる
   *
   * @param $
   * @param appData
   * @returns {Promise}
   */
  analyzeAndroidData($, appData) {
    var that = this;
    return new Promise((resolve, reject) => {
      gplay.reviews({
        appId: appData.appId,
        sort: gplay.sort.NEWEST,
        lang: appData.langCountryCode,
        num: 5
      }).then(function (value) {
        let reviewProcess = []
        for (let element of value) {
          reviewProcess.push(that.getAndroidReview(appData, element));
        }

        Promise.all(reviewProcess).then((data) => {
          let returnData = [];
          for (let i = 0; i < data.length; i++) {
            if (data[i] !== null) {
              returnData.push(data[i]);
            }
          }
          resolve(returnData);
        });
      });
    });
  }


  /**
   * Androidのレビュー情報の解析処理。
   * 取得したレビュー情報が新規であればDBに保存し、通知用データとして返却する。
   *
   * @param appData
   * @param element
   * @returns {Promise}
   */
  getAndroidReview(appData, element) {
    return new Promise((resolve, reject) => {
      let param = [];

      param.reviewId = element.id
      param.kind = appData.kind

      param.name = appData.name
      param.title = "";
      param.titleLink = "";

      param.message = element.text
      param.rating = element.score
      param.updated = formatDate(new Date(element.date), "YYYY/MM/DD hh:mm:ss"); 
      param.version = element.version;

      const reviewData = new ReviewData(param);
      // DBに登録を試みて、登録できれば新規レビューなので通知用レビューデータとして返却する
      this.insertReviewData(appData, reviewData).then((result) => {
        this.pushData(result, reviewData).then((data) => {
          resolve(data)
        });
      });
    });
  }

  /**
   * レビューデータをDBに保存する。
   * テーブルにレビューIDがすでに存在する場合は登録処理をしないでfalseを返す。
   * Insertできた場合はtrueを返す。
   *
   * @param appData
   * @param reviewData
   * @returns {Promise}
   */
  insertReviewData(appData, reviewData) {

    return new Promise((resolve, reject) => {
      this.selectRecord(reviewData, appData.kind).then((result) => {

        // レコードの有無をチェックする
        if (result.cnt === 0) {
          this.db.serialize(() => {
            // 挿入用プリペアドステートメントを準備
            const ins_androidReview = this.db.prepare(
              "INSERT INTO review(id, kind, app_name, title, message, rating, updated, version, create_date) " +
              "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)");

            ins_androidReview.run(
              reviewData.reviewId, appData.kind, appData.name, reviewData.title, reviewData.message,
              reviewData.rating, reviewData.updated, reviewData.version, new Date());
            ins_androidReview.finalize();
          });
          resolve(true);
        } else {
          resolve(false);
        }
      }).catch((err) => {
        console.log('DB Failure:', err);
        reject(false);
      });
    });
  }

  /**
   * 通知対象とするかの判定処理
   *
   * @param result
   * @param reviewData
   * @returns {Promise}
   */
  pushData(result, reviewData) {
    return new Promise((resolve, reject) => {
      // DB登録ができて通知可能な場合に、通知対象とする
      if (result && !this.ignoreNotification) {
        resolve(reviewData);
      } else {
        // レビュー情報が重複している、または通知しないオプションが付いていれば通知対象にしない
        resolve(null);
      }
    });
  }

  /**
   * レビュー情報がすでにDBに存在しているかを調べる。
   * レビューIDでのカウント数を返す。（0 or 1）
   *
   * @param condition チェック対象のレビューデータ
   * @param kind アプリのOS種別
   */
  selectRecord(condition, kind) {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.get('SELECT count(*) as cnt FROM review WHERE id = $id AND kind = $kind',
          { $id: condition.reviewId, $kind: kind },
          (err, res) => {
            if (err) {
              return reject(err);
            }
            resolve(res);
          });
      });
    });
  }
}
