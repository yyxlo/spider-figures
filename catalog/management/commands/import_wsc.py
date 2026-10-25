"""Import a species checklist (e.g. a World Spider Catalog export) from CSV/TSV.

The exact column layout of WSC exports could not be verified while writing
this command, so columns are matched by a list of common header names
(case-insensitive) and can be overridden with --column FIELD=HEADER.
Run with --dry-run first and check the detected column mapping.

Recognised fields (first matching header wins):
  family, genus, species (epithet), subspecies, author, year, parens,
  species_lsid, genus_lsid, family_lsid, common_name,
  rank and status (Darwin Core style files: only accepted species/subspecies are imported)
"""
import csv
import re
import sys

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from catalog.models import Family, Genus, Species

ALIASES = {
    "family": ["family", "familyname", "family_name"],
    "genus": ["genus", "genusname", "genus_name"],
    "species": ["species", "epithet", "specificepithet", "species_epithet", "speciesname", "species_name"],
    "subspecies": ["subspecies", "infraspecificepithet", "subspecies_epithet"],
    "author": ["author", "authors", "authorship", "scientificnameauthorship", "species_author"],
    "year": ["year", "species_year", "namepublishedinyear"],
    "parens": ["parens", "parentheses", "brackets"],
    "species_lsid": ["species_lsid", "speciesid_lsid", "lsid", "taxonid", "taxon_id"],
    "genus_lsid": ["genus_lsid"],
    "family_lsid": ["family_lsid"],
    "common_name": ["common_name", "vernacularname", "chinese_name", "中文名"],
    "rank": ["taxonrank", "rank"],
    "status": ["taxonomicstatus", "status"],
}

ACCEPTED_STATUS = {"", "accepted", "valid", "accepted name"}
SPECIES_RANKS = {"species", "subspecies"}


def norm(h):
    return re.sub(r"[\s\-]+", "_", h.strip().lower()).replace("_", "") if h else ""


class Command(BaseCommand):
    help = "從 CSV/TSV 匯入科、屬、種名錄（例如 World Spider Catalog 匯出檔）"

    def add_arguments(self, parser):
        parser.add_argument("path", help="CSV 或 TSV 檔案路徑")
        parser.add_argument("--delimiter", help="欄位分隔符號，預設自動判斷")
        parser.add_argument("--encoding", default="utf-8-sig")
        parser.add_argument("--column", action="append", default=[], metavar="FIELD=HEADER",
                            help="手動指定欄位對應，例如 --column species=epithet")
        parser.add_argument("--family", action="append", default=[],
                            help="只匯入指定的科（可重複），例如 --family Araneidae")
        parser.add_argument("--dry-run", action="store_true", help="只檢查，不寫入資料庫")

    def handle(self, path, delimiter, encoding, column, family, dry_run, **opts):
        try:
            fh = open(path, newline="", encoding=encoding)
        except OSError as e:
            raise CommandError(e)
        with fh:
            sample = fh.read(8192)
            fh.seek(0)
            if not delimiter:
                try:
                    delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
                except csv.Error:
                    delimiter = "\t" if sample.count("\t") > sample.count(",") else ","
            reader = csv.DictReader(fh, delimiter=delimiter)
            mapping = self.build_mapping(reader.fieldnames or [], column)
            self.stdout.write("欄位對應：")
            for field in ALIASES:
                self.stdout.write(f"  {field:13} ← {mapping.get(field, '（無）')}")
            missing = [f for f in ("family", "genus", "species") if f not in mapping]
            if missing:
                raise CommandError(
                    f"找不到必要欄位 {missing}。檔案的欄位有：{reader.fieldnames}。"
                    "請用 --column 指定，例如 --column species=epithet"
                )
            only_families = {f.lower() for f in family}
            with transaction.atomic():
                stats = self.import_rows(reader, mapping, only_families)
                if dry_run:
                    transaction.set_rollback(True)
        self.stdout.write(self.style.SUCCESS(
            ("[試跑，未寫入] " if dry_run else "")
            + "讀取 {rows} 列；新增 科 {families}、屬 {genera}、種 {species_new}；"
              "更新 種 {species_updated}；略過 {skipped} 列".format(**stats)
        ))

    def build_mapping(self, headers, overrides):
        by_norm = {norm(h): h for h in headers}
        mapping = {}
        for field, aliases in ALIASES.items():
            for alias in aliases:
                if norm(alias) in by_norm:
                    mapping[field] = by_norm[norm(alias)]
                    break
        for item in overrides:
            if "=" not in item:
                raise CommandError(f"--column 格式應為 FIELD=HEADER：{item}")
            field, header = item.split("=", 1)
            if field not in ALIASES:
                raise CommandError(f"未知欄位 {field}，可用：{', '.join(ALIASES)}")
            if header not in headers:
                raise CommandError(f"檔案中沒有欄位 {header}")
            mapping[field] = header
        return mapping

    def import_rows(self, reader, m, only_families):
        stats = dict(rows=0, families=0, genera=0, species_new=0, species_updated=0, skipped=0)
        families = {f.name: f for f in Family.objects.all()}
        genera = {g.name: g for g in Genus.objects.all()}

        def get(row, field):
            col = m.get(field)
            return (row.get(col) or "").strip() if col else ""

        for row in reader:
            stats["rows"] += 1
            if "rank" in m and get(row, "rank").lower() not in SPECIES_RANKS:
                stats["skipped"] += 1
                continue
            if "status" in m and get(row, "status").lower() not in ACCEPTED_STATUS:
                stats["skipped"] += 1
                continue
            fam_name, gen_name, epithet = get(row, "family"), get(row, "genus"), get(row, "species").lower()
            if not (fam_name and gen_name and epithet):
                stats["skipped"] += 1
                continue
            if only_families and fam_name.lower() not in only_families:
                stats["skipped"] += 1
                continue

            fam = families.get(fam_name)
            if fam is None:
                fam = families[fam_name] = Family.objects.create(name=fam_name, wsc_lsid=get(row, "family_lsid"))
                stats["families"] += 1
            gen = genera.get(gen_name)
            if gen is None:
                gen = genera[gen_name] = Genus.objects.create(
                    name=gen_name, family=fam, wsc_lsid=get(row, "genus_lsid"))
                stats["genera"] += 1

            author = self.format_author(get(row, "author"), get(row, "year"), get(row, "parens"))
            defaults = {"author": author}
            if get(row, "species_lsid"):
                defaults["wsc_lsid"] = get(row, "species_lsid")
            if get(row, "common_name"):
                defaults["common_name"] = get(row, "common_name")
            _, created = Species.objects.update_or_create(
                genus=gen, epithet=epithet, subspecies=get(row, "subspecies").lower(), defaults=defaults)
            stats["species_new" if created else "species_updated"] += 1
            if stats["rows"] % 5000 == 0:
                self.stdout.write(f"  …{stats['rows']} 列", ending="\n")
                sys.stdout.flush()
        return stats

    @staticmethod
    def format_author(author, year, parens):
        """Combine separate author / year / parentheses columns into '(Author, 1890)'."""
        if not author:
            return ""
        text = author
        if year and year not in author:
            text = f"{author}, {year}"
        if parens.lower() in ("1", "true", "yes", "y") and not text.startswith("("):
            text = f"({text})"
        return text
