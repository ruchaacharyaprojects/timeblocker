package com.timeblocker.healthsleep

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

/**
 * DEBUG-ONLY demo sleep data (R25.5). Real implementation; the release build
 * compiles `android-release/HealthDemo.kt` (a rejecting stub) instead.
 *
 * Design: every record is a manual entry with clientRecordId
 * `timeblocker-demo-<startMs>`, so re-writing the same night is an upsert and
 * [delete] can find our records: it reads back only this app's own sleep
 * records (dataOriginFilter = own package; Health Connect also only lets an
 * app delete its own records) and deletes those with the demo prefix by record id.
 */
object HealthDemo {
    const val AVAILABLE = true

    suspend fun write(context: Context, sessions: List<DemoSleepSession>) {
        val client = HealthConnectClient.getOrCreate(context)
        val records = sessions
            .filter { it.endMs > it.startMs }
            .map { s ->
                val start = Instant.ofEpochMilli(s.startMs)
                val end = Instant.ofEpochMilli(s.endMs)
                val awakeMs = (s.awakeMin.coerceAtLeast(0) * 60_000L)
                    .coerceAtMost((s.endMs - s.startMs) / 2)
                // Awake stage in the middle of the night, sleeping stages around it.
                val midpoint = s.startMs + (s.endMs - s.startMs) / 2
                val awakeStart = midpoint - awakeMs / 2
                val awakeEnd = awakeStart + awakeMs
                val stages = buildList {
                    if (awakeStart > s.startMs) {
                        add(
                            SleepSessionRecord.Stage(
                                start, Instant.ofEpochMilli(awakeStart),
                                SleepSessionRecord.STAGE_TYPE_SLEEPING,
                            ),
                        )
                    }
                    if (awakeEnd > awakeStart) {
                        add(
                            SleepSessionRecord.Stage(
                                Instant.ofEpochMilli(awakeStart), Instant.ofEpochMilli(awakeEnd),
                                SleepSessionRecord.STAGE_TYPE_AWAKE,
                            ),
                        )
                    }
                    if (s.endMs > awakeEnd) {
                        add(
                            SleepSessionRecord.Stage(
                                Instant.ofEpochMilli(awakeEnd), end,
                                SleepSessionRecord.STAGE_TYPE_SLEEPING,
                            ),
                        )
                    }
                }
                SleepSessionRecord(
                    startTime = start,
                    startZoneOffset = ZoneOffset.UTC,
                    endTime = end,
                    endZoneOffset = ZoneOffset.UTC,
                    metadata = Metadata.manualEntry(clientRecordId = DEMO_CLIENT_ID_PREFIX + s.startMs),
                    title = "TimeBlocker demo",
                    stages = stages,
                )
            }
        if (records.isNotEmpty()) client.insertRecords(records)
    }

    /** Deletes this app's demo records. Returns how many were removed. */
    suspend fun delete(context: Context): Int {
        val client = HealthConnectClient.getOrCreate(context)
        val ids = ArrayList<String>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = SleepSessionRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(
                        Instant.EPOCH,
                        Instant.now().plus(3650, ChronoUnit.DAYS),
                    ),
                    dataOriginFilter = setOf(DataOrigin(context.packageName)),
                    pageToken = pageToken,
                ),
            )
            response.records
                .filter { it.metadata.clientRecordId?.startsWith(DEMO_CLIENT_ID_PREFIX) == true }
                .forEach { ids.add(it.metadata.id) }
            pageToken = response.pageToken
        } while (pageToken != null)
        if (ids.isNotEmpty()) {
            client.deleteRecords(SleepSessionRecord::class, ids, emptyList())
        }
        return ids.size
    }
}
