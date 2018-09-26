// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


import * as follow_redirects from '../infrastructure/follow_redirects';
import {JsonConfig} from '../infrastructure/json_config';
import * as logging from '../infrastructure/logging';
import {AccessKeyId} from '../model/access_key';

import {ServerConfigJson} from './server_config';

const MS_PER_HOUR = 60 * 60 * 1000;
const SANCTIONED_COUNTRIES = new Set(['CU', 'IR', 'KP', 'SY']);

// Used internally to track key usage.
interface KeyUsage {
  accessKeyMetricsId: string;
  inboundBytes: number;
  countries: Set<string>;
}

// JSON format for the published report.
// Field renames will break backwards-compatibility.
interface HourlyServerMetricsReportJson {
  serverId: string;
  startUtcMs: number;
  endUtcMs: number;
  userReports: HourlyUserMetricsReportJson[];
}

// JSON format for the published report.
// Field renames will break backwards-compatibility.
interface HourlyUserMetricsReportJson {
  userId: string;
  countries: string[];
  bytesTransferred: number;
}

export interface SharedMetricsReporter {
  startSharing();
  stopSharing();
  isSharingEnabled();
}

export interface UsageMetrics { getUsage(): KeyUsage[]; }

export interface UsageMetricsRecorder {
  recordBytesTransferred(accessKeyMetricsId: AccessKeyId, numBytes: number, countries: string[]);
}

// Holds one hour usage metrics in memory.
// TODO: migrate to an implementation that uses Prometheus.
export class InMemoryOneHourUsageMetrics implements UsageMetrics, UsageMetricsRecorder {
  // Map from the metrics AccessKeyId to metrics (bytes transferred, IP addresses).
  private lastHourUsage = new Map<AccessKeyId, KeyUsage>();

  getUsage(): KeyUsage[] {
    return [...this.lastHourUsage.values()];
  }

  // We use a separate metrics id so the accessKey id is not disclosed.
  recordBytesTransferred(accessKeyMetricsId: AccessKeyId, numBytes: number, countries: string[]) {
    // Don't record data for sanctioned countries.
    for (const country of countries) {
      if (SANCTIONED_COUNTRIES.has(country)) {
        return;
      }
    }
    if (numBytes === 0) {
      return;
    }
    let keyUsage = this.lastHourUsage.get(accessKeyMetricsId);
    if (!keyUsage) {
      keyUsage = {accessKeyMetricsId, inboundBytes: 0, countries: new Set<string>()};
      this.lastHourUsage.set(accessKeyMetricsId, keyUsage);
    }
    keyUsage.inboundBytes += numBytes;
    for (const country of countries) {
      keyUsage.countries.add(country);
    }
  }
}

// Keeps track of the connection metrics per user, since the startDatetime.
// This is reported to the Outline team if the admin opts-in.
export class OutlineSharedMetricsReporter implements SharedMetricsReporter {
  // Time at which we started recording connection metrics, e.g.
  // in case this object is constructed from data written to disk.
  private previousReportTime: Date;
  private reportedKeyData = new Map<string, number>();

  constructor(
      private serverConfig: JsonConfig<ServerConfigJson>, private metricsUrl: string,
      usageMetrics: UsageMetrics) {
    // Start timer
    this.previousReportTime = new Date();

    setInterval(() => {
      if (!this.isSharingEnabled()) {
        return;
      }
      this.reportMetrics(usageMetrics.getUsage());
    }, MS_PER_HOUR);
  }

  startSharing() {
    this.serverConfig.data().metricsEnabled = true;
    this.serverConfig.write();
  }

  stopSharing() {
    this.serverConfig.data().metricsEnabled = false;
    this.serverConfig.write();
  }

  isSharingEnabled(): boolean {
    return this.serverConfig.data().metricsEnabled || false;
  }

  private reportMetrics(lastHourUsage: KeyUsage[]) {
    const reportTime = new Date();

    const userReports = [] as HourlyUserMetricsReportJson[];
    const newReportedKeyData = new Map<string, number>();
    for (const keyUsage of lastHourUsage) {
      const dataDelta =
          keyUsage.inboundBytes - (this.reportedKeyData[keyUsage.accessKeyMetricsId] || 0);
      if (dataDelta === 0) {
        continue;
      }
      userReports.push({
        userId: keyUsage.accessKeyMetricsId,
        bytesTransferred: dataDelta,
        countries: [...keyUsage.countries]
      });
      newReportedKeyData[keyUsage.accessKeyMetricsId] = keyUsage.inboundBytes;
    }
    if (userReports.length === 0) {
      return;
    }
    const report = {
      serverId: this.serverConfig.data().serverId,
      startUtcMs: this.previousReportTime.getTime(),
      endUtcMs: reportTime.getTime(),
      userReports
    } as HourlyServerMetricsReportJson;

    postHourlyServerMetricsReports(report, this.metricsUrl);

    this.previousReportTime = reportTime;
    this.reportedKeyData = newReportedKeyData;
  }
}

export function postHourlyServerMetricsReports(
    reportJson: HourlyServerMetricsReportJson, metricsUrl: string) {
  const options = {
    url: metricsUrl,
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
    body: JSON.stringify(reportJson)
  };
  logging.info('Posting metrics: ' + JSON.stringify(options));
  return follow_redirects.requestFollowRedirectsWithSameMethodAndBody(
      options, (error, response, body) => {
        if (error) {
          logging.error(`Error posting metrics: ${error}`);
          return;
        }
        logging.info('Metrics server responded with status ' + response.statusCode);
      });
}
