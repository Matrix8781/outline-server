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

import * as http from 'http';

export interface QueryResultData {
  resultType: 'matrix'|'vector'|'scalar'|'string';
  result: Array<{metric: {[labelValue: string]: string}; value: [number, string];}>;
}

// From https://prometheus.io/docs/prometheus/latest/querying/api/
interface QueryResult {
  status: 'success'|'error';
  data: QueryResultData;
  errorType: string;
  error: string;
}

export class PrometheusClient {
  constructor(private address: string) {}

  query(query: string): Promise<QueryResultData> {
    return new Promise<QueryResultData>((fulfill, reject) => {
      const url = `${this.address}/api/v1/query?query=${encodeURIComponent(query)}`;
      http.get(url, (response) => {
            if (response.statusCode < 200 || response.statusCode > 299) {
              reject(new Error(`Got error ${response.statusCode}`));
              response.resume();
              return;
            }
            let body = '';
            response.on('data', (data) => {
              body += data;
            });
            response.on('end', () => {
              const result = JSON.parse(body) as QueryResult;
              if (result.status !== 'success') {
                return reject(new Error(`Error ${result.errorType}: ${result.error}`));
              }
              fulfill(result.data);
            });
          }).on('error', (e) => {
        reject(new Error(`Failed to query prometheus API: ${e}`));
      });
    });
  }
}
